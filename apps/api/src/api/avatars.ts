// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { can } from '../auth/can';
import { consume } from '../auth/rate-limit';
import { avatarKey, avatarPath, avatarState, shareSpace } from '../db/avatars';
import { getUser } from '../db/users';
import { ApiError } from '../errors';
import { type AppEnv, requireUser } from './context';
import { id } from './schemas';

// Profile photos (Settings -> Profile; migrations/0012_avatars.sql). The browser crops and
// shrinks the photo to a 256 x 256 WebP before sending it, so the upload is small; the checks
// here hold for any client. The photo sits in the instance's private bucket under avatars/ and
// is only served to people who share a space with its owner (can(user.avatar.view)). R2 sees one
// write per upload and one read per first view of each version: the URL carries the version, so
// browsers keep it for a year and a new photo is a new URL.

export const avatars = new Hono<AppEnv>();

/** The largest photo the API stores. The web sends about 10 to 40 KB. */
export const MAX_AVATAR_BYTES = 512 * 1024;

/** Photo changes per person per hour (uploads only; removing one costs nothing). */
export const AVATAR_UPLOADS_PER_HOUR = 10;

const TYPES = {
  'image/webp': (b: Uint8Array) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  'image/png': (b: Uint8Array) =>
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  'image/jpeg': (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
} as const;

type ImageType = keyof typeof TYPES;

const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, to));

const isImageType = (value: string): value is ImageType => Object.hasOwn(TYPES, value);

const VERSION = /^[a-z0-9]{1,16}$/;

/** What the profile card shows next to the user. */
async function profile(db: D1Database, userId: string) {
  const [user, avatar] = await Promise.all([getUser(db, userId), avatarState(db, userId)]);
  return { user, avatar };
}

/**
 * PUT /api/me/avatar: the body is the photo itself (Content-Type image/webp, image/png or
 * image/jpeg, at most MAX_AVATAR_BYTES), checked against its first bytes. 413 when too large,
 * 415 for anything else, 429 past AVATAR_UPLOADS_PER_HOUR.
 */
avatars.put('/me/avatar', async (c) => {
  const user = await requireUser(c);
  const type = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!isImageType(type)) throw new ApiError(415, 'invalid_message', { path: '' });
  const declared = Number(c.req.header('Content-Length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
    throw new ApiError(413, 'invalid_message', { path: '', limit: MAX_AVATAR_BYTES });
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > MAX_AVATAR_BYTES) {
    throw new ApiError(413, 'invalid_message', { path: '', limit: MAX_AVATAR_BYTES });
  }
  if (bytes.byteLength < 12 || !TYPES[type](bytes)) {
    throw new ApiError(415, 'invalid_message', { path: '' });
  }
  const now = Date.now();
  const wait = await consume(
    c.env.DB,
    [
      {
        bucket: `avatar_upload:${user.id}`,
        max: AVATAR_UPLOADS_PER_HOUR,
        windowMs: 60 * 60 * 1000,
      },
    ],
    now,
  );
  if (wait > 0) throw new ApiError(429, 'rate_limited', { retryAfterMs: wait });
  await c.env.THUMBNAILS.put(avatarKey(user.id), bytes, {
    httpMetadata: { contentType: type },
  });
  await c.env.DB.prepare("UPDATE users SET avatar_url = ?, avatar_source = 'upload' WHERE id = ?")
    .bind(avatarPath(user.id, now.toString(36)), user.id)
    .run();
  return c.json(await profile(c.env.DB, user.id));
});

/** DELETE /api/me/avatar: no photo (initials), also after later Discord logins. */
avatars.delete('/me/avatar', async (c) => {
  const user = await requireUser(c);
  await c.env.DB.prepare("UPDATE users SET avatar_url = NULL, avatar_source = 'none' WHERE id = ?")
    .bind(user.id)
    .run();
  await c.env.THUMBNAILS.delete(avatarKey(user.id));
  return c.json(await profile(c.env.DB, user.id));
});

/**
 * POST /api/me/avatar/discord: back to the Discord photo, which later logins keep up to date.
 * 404 when the account has none (no Discord link, or no photo there).
 */
avatars.post('/me/avatar/discord', async (c) => {
  const user = await requireUser(c);
  const res = await c.env.DB.prepare(
    `UPDATE users SET avatar_url = discord_avatar_url, avatar_source = NULL
     WHERE id = ? AND discord_avatar_url IS NOT NULL`,
  )
    .bind(user.id)
    .run();
  if (res.meta.changes === 0) throw new ApiError(404, 'not_found');
  await c.env.THUMBNAILS.delete(avatarKey(user.id));
  return c.json(await profile(c.env.DB, user.id));
});

/**
 * GET /api/avatars/:userId/:version: an uploaded photo. Only the current version is served; one
 * 404 for "no such person", "no such version" and "not yours to see", so nothing can be probed.
 */
avatars.get('/avatars/:userId/:version', async (c) => {
  const viewer = await requireUser(c);
  const userId = c.req.param('userId');
  const version = c.req.param('version');
  const notFound = () => new ApiError(404, 'not_found');
  if (!id.safeParse(userId).success || !VERSION.test(version)) throw notFound();
  const now = Date.now();
  const actor = { userId: viewer.id, isPlatformAdmin: viewer.isPlatformAdmin, membership: null };
  const sharesSpace =
    viewer.isPlatformAdmin || viewer.id === userId
      ? false
      : await shareSpace(c.env.DB, viewer.id, userId, now);
  if (!can(actor, 'user.avatar.view', { userId, sharesSpace }).allowed) throw notFound();
  const owner = await getUser(c.env.DB, userId);
  if (owner?.avatarUrl !== avatarPath(userId, version)) throw notFound();
  const headers = new Headers({
    // The version is in the URL: this exact URL never changes, a new photo gets a new one.
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  const match = c.req.header('If-None-Match');
  const object = await c.env.THUMBNAILS.get(avatarKey(userId));
  if (!object) throw notFound();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'image/webp');
  headers.set('ETag', object.httpEtag);
  if (match && match.split(',').some((t) => t.trim() === object.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { status: 200, headers });
});
