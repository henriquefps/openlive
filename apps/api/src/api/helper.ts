// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { can } from '../auth/can';
import { consume } from '../auth/rate-limit';
import { ApiError } from '../errors';
import {
  ANDROID_KEY,
  type AndroidManifest,
  type HelperManifest,
  helperFileKey,
  helperFileOf,
  LATEST_KEY,
  parseAndroidManifest,
  parseHelperManifest,
  releaseRepoOf,
} from '../helper/release';
import type { User } from '../db/users';
import { type AppEnv, authenticate, type Ctx } from './context';

// Downloading the helper from the instance (src/helper/release.ts). The manifest is
// read only by signed-in people with a reason to download: members of any space and the platform
// admin (can(helper.download)). Its files are either public GitHub release assets (the default:
// the browser downloads them from GitHub) or, for a fork that uploads its own builds, objects in the
// instance's private bucket that the Worker streams after this check.

export const helper = new Hono<AppEnv>();

/** Downloads per person per hour: a release is two files, this leaves room for retries. */
export const DOWNLOADS_PER_HOUR = 20;

async function memberOfAnySpace(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS one FROM space_members m
       JOIN spaces s ON s.id = m.space_id AND s.deleted_at IS NULL AND s.suspended_at IS NULL
       WHERE m.user_id = ? AND m.banned_at IS NULL LIMIT 1`,
    )
    .bind(userId)
    .first<{ one: number }>();
  return row !== null;
}

/** The caller, or 401/403 when they may not download the helper. */
async function requireDownloader(c: Ctx): Promise<User> {
  const { user } = await authenticate(c);
  const actor = { userId: user.id, isPlatformAdmin: user.isPlatformAdmin, membership: null };
  const member = user.isPlatformAdmin ? true : await memberOfAnySpace(c.env.DB, user.id);
  if (!can(actor, 'helper.download', { memberOfAnySpace: member }).allowed) {
    throw new ApiError(403, 'forbidden');
  }
  return user;
}

const downloadPath = (version: string, name: string) =>
  `/api/helper/download/${encodeURIComponent(version)}/${encodeURIComponent(name)}`;

/**
 * GET /api/helper/latest: helper/latest.json with a download path per file, or 404 when nothing
 * is published. A manifest that does not parse is a publishing mistake: 500, and logged.
 */
helper.get('/helper/latest', async (c) => {
  await requireDownloader(c);
  const object = await c.env.THUMBNAILS.get(LATEST_KEY);
  if (!object) throw new ApiError(404, 'not_found');
  const manifest = parseHelperManifest(
    await object.text(),
    releaseRepoOf(c.env.HELPER_RELEASE_REPO),
  );
  if (!manifest) {
    console.error(`${LATEST_KEY} is not a valid helper manifest; publish it again`);
    throw new ApiError(500, 'internal_error');
  }
  const body: HelperManifest & { files: { url: string }[] } = {
    ...manifest,
    files: manifest.files.map((f) => ({
      ...f,
      url: f.url ?? downloadPath(manifest.version, f.name),
    })),
  };
  c.header('Cache-Control', 'private, no-cache');
  return c.json(body);
});

/**
 * GET /api/helper/android: helper/android.json, the APK of an Android release on GitHub, or 404
 * when none was published (the page then links to the releases). Same permission as the helper.
 */
helper.get('/helper/android', async (c) => {
  await requireDownloader(c);
  const object = await c.env.THUMBNAILS.get(ANDROID_KEY);
  if (!object) throw new ApiError(404, 'not_found');
  const android: AndroidManifest | null = parseAndroidManifest(
    await object.text(),
    releaseRepoOf(c.env.HELPER_RELEASE_REPO),
  );
  if (!android) {
    console.error(`${ANDROID_KEY} is not a valid Android manifest; publish it again`);
    throw new ApiError(500, 'internal_error');
  }
  c.header('Cache-Control', 'private, no-cache');
  return c.json(android);
});

/**
 * GET /api/helper/download/:version/:file: one release file, streamed from R2 as an attachment.
 * Only the names a release holds are served (src/helper/release.ts); anything else is 404.
 */
helper.get('/helper/download/:version/:file', async (c) => {
  const user = await requireDownloader(c);
  const version = c.req.param('version');
  const name = c.req.param('file');
  const file = helperFileOf(version, name);
  if (!file) throw new ApiError(404, 'not_found');
  const wait = await consume(
    c.env.DB,
    [{ bucket: `helper_download:${user.id}`, max: DOWNLOADS_PER_HOUR, windowMs: 60 * 60 * 1000 }],
    Date.now(),
  );
  if (wait > 0) throw new ApiError(429, 'rate_limited', { retryAfterMs: wait });
  const object = await c.env.THUMBNAILS.get(helperFileKey(version, name));
  if (!object) throw new ApiError(404, 'not_found');
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': file.contentType,
      'Content-Length': String(object.size),
      'Content-Disposition': `attachment; filename="${name}"`,
      // A version's files never change; the browser may keep them, shared caches may not.
      'Cache-Control': 'private, max-age=86400',
      ETag: object.httpEtag,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
