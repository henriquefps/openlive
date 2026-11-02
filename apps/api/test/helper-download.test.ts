// SPDX-License-Identifier: AGPL-3.0-only
import { env, exports } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEV_USER_HEADER } from '../src/room/identity';
import { DOWNLOADS_PER_HOUR } from '../src/api/helper';
import {
  helperFileKey,
  helperFileName,
  helperFileOf,
  LATEST_KEY,
  parseHelperManifest,
} from '../src/helper/release';
import { addMember, call, migrate, newUser, world } from './api-helpers';

// Downloading the helper from the instance: who may, the 404 before anything is
// published, the manifest checks and the download headers.

beforeAll(migrate);

const VERSION = '0.2.0';
const TARBALL = helperFileName(VERSION, 'tarball');
const FLATPAK = helperFileName(VERSION, 'flatpak');
const DMG = helperFileName(VERSION, 'dmg');

function manifest(over: Record<string, unknown> = {}) {
  return {
    schema: 1,
    version: VERSION,
    publishedAt: '2026-10-28T12:00:00.000Z',
    protocol: { major: 1, minor: 12 },
    releaseNotesUrl: null,
    files: [
      {
        name: TARBALL,
        kind: 'tarball',
        os: 'linux',
        arch: 'amd64',
        size: 3,
        sha256: 'a'.repeat(64),
      },
      {
        name: FLATPAK,
        kind: 'flatpak',
        os: 'linux',
        arch: 'amd64',
        size: 5,
        sha256: 'b'.repeat(64),
      },
    ],
    signature: null,
    ...over,
  };
}

async function publish(m: unknown = manifest()) {
  await env.THUMBNAILS.put(LATEST_KEY, typeof m === 'string' ? m : JSON.stringify(m));
}

function download(path: string, userId?: string, method = 'GET') {
  return exports.default.fetch(`http://localhost/api/helper/download/${path}`, {
    method,
    headers: userId ? { [DEV_USER_HEADER]: userId } : {},
  });
}

beforeEach(async () => {
  await env.THUMBNAILS.delete(LATEST_KEY);
});

describe('GET /api/helper/latest', () => {
  it('needs a signed-in member of a space or the platform admin', async () => {
    await publish();
    const w = await world();
    const admin = await newUser('padmin', { platformAdmin: true });
    expect((await call('GET', '/helper/latest')).status).toBe(401);
    expect(await call('GET', '/helper/latest', w.outsider)).toEqual({
      status: 403,
      body: { code: 'forbidden' },
    });
    for (const who of [w.owner, w.member, w.guest, admin]) {
      expect((await call('GET', '/helper/latest', who)).status).toBe(200);
    }
  });

  it('refuses someone banned from their only space', async () => {
    await publish();
    const w = await world();
    const banned = await newUser('banned');
    await addMember(w.spaceId, banned, 'member');
    await env.DB.prepare('UPDATE space_members SET banned_at = ? WHERE user_id = ?')
      .bind(Date.now(), banned)
      .run();
    expect((await call('GET', '/helper/latest', banned)).status).toBe(403);
  });

  it('answers 404 when nothing is published', async () => {
    const w = await world();
    expect(await call('GET', '/helper/latest', w.member)).toEqual({
      status: 404,
      body: { code: 'not_found' },
    });
  });

  it('returns the manifest with a download path per file', async () => {
    await publish({ ...manifest(), extra: 'dropped' });
    const w = await world();
    const res = await exports.default.fetch('http://localhost/api/helper/latest', {
      headers: { [DEV_USER_HEADER]: w.member },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ...manifest(),
      files: manifest().files.map((f) => ({
        ...f,
        url: `/api/helper/download/${VERSION}/${f.name}`,
      })),
    });
  });

  it('answers 500 for a manifest that does not parse', async () => {
    const w = await world();
    await publish('{not json');
    expect((await call('GET', '/helper/latest', w.member)).status).toBe(500);
  });
});

describe('parseHelperManifest', () => {
  const parse = (m: unknown) => parseHelperManifest(JSON.stringify(m));

  it('accepts what the publish script writes', () => {
    expect(parse(manifest())?.version).toBe(VERSION);
    expect(parse(manifest({ releaseNotesUrl: 'https://example.com/notes' }))).not.toBeNull();
    const pre = '1.0.0-beta.1';
    const [tar] = manifest().files;
    expect(
      parse(manifest({ version: pre, files: [{ ...tar, name: helperFileName(pre, 'tarball') }] })),
    ).not.toBeNull();
    expect(parse(manifest({ files: [] }))).toBeNull();
  });

  it('accepts the universal macOS disk image, only as macos/universal', () => {
    const dmg = {
      name: DMG,
      kind: 'dmg',
      os: 'macos',
      arch: 'universal',
      size: 9,
      sha256: 'c'.repeat(64),
    };
    expect(parse(manifest({ files: [...manifest().files, dmg] }))?.files).toHaveLength(3);
    expect(parse(manifest({ files: [{ ...dmg, os: 'linux' }] }))).toBeNull();
    expect(parse(manifest({ files: [{ ...dmg, arch: 'amd64' }] }))).toBeNull();
    const [tar] = manifest().files;
    expect(parse(manifest({ files: [{ ...tar, os: 'macos' }] }))).toBeNull();
    expect(parse(manifest({ files: [{ ...dmg, name: TARBALL }] }))).toBeNull();
  });

  it('refuses other schemas, bad versions, hashes and names, and a signature', () => {
    expect(parse(manifest({ schema: 2 }))).toBeNull();
    expect(parse(manifest({ version: 'v1' }))).toBeNull();
    expect(parse(manifest({ signature: 'abc' }))).toBeNull();
    const [tar, flat] = manifest().files;
    expect(parse(manifest({ files: [{ ...tar, sha256: 'A'.repeat(64) }] }))).toBeNull();
    expect(parse(manifest({ files: [{ ...tar, name: FLATPAK }] }))).toBeNull();
    expect(parse(manifest({ files: [{ ...flat, size: -1 }] }))).toBeNull();
    expect(parseHelperManifest('')).toBeNull();
  });
});

describe('helperFileOf', () => {
  it('knows the four names of a release, and nothing else', () => {
    expect(helperFileOf(VERSION, TARBALL)?.contentType).toBe('application/gzip');
    expect(helperFileOf(VERSION, DMG)?.contentType).toBe('application/x-apple-diskimage');
    expect(helperFileOf(VERSION, FLATPAK)?.contentType).toBe('application/vnd.flatpak');
    expect(helperFileOf(VERSION, 'SHA256SUMS')?.kind).toBe('checksums');
    expect(helperFileOf(VERSION, helperFileName('0.1.0', 'tarball'))).toBeNull();
    expect(helperFileOf('../x', 'SHA256SUMS')).toBeNull();
    expect(helperFileOf(VERSION, 'latest.json')).toBeNull();
  });
});

describe('GET /api/helper/download/:version/:file', () => {
  it('streams each size whole, as an attachment with its type and length', async () => {
    const w = await world();
    for (const [name, size, type] of [
      [TARBALL, 0, 'application/gzip'],
      [TARBALL, 1, 'application/gzip'],
      [FLATPAK, 256 * 1024 + 7, 'application/vnd.flatpak'],
      [DMG, 17, 'application/x-apple-diskimage'],
      ['SHA256SUMS', 130, 'text/plain; charset=utf-8'],
    ] as const) {
      const bytes = new Uint8Array(size).map((_, i) => i % 251);
      await env.THUMBNAILS.put(helperFileKey(VERSION, name), bytes);
      const res = await download(`${VERSION}/${name}`, w.member);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe(type);
      expect(res.headers.get('Content-Length')).toBe(String(size));
      expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="${name}"`);
      expect(res.headers.get('Cache-Control')).toMatch(/^private\b/);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    }
  });

  it('needs the same permission as the manifest', async () => {
    await env.THUMBNAILS.put(helperFileKey(VERSION, TARBALL), new Uint8Array(4));
    const w = await world();
    expect((await download(`${VERSION}/${TARBALL}`)).status).toBe(401);
    const res = await download(`${VERSION}/${TARBALL}`, w.outsider);
    expect(res.status).toBe(403);
    await res.arrayBuffer();
  });

  it('answers 404 for a missing file, another name or another prefix', async () => {
    const w = await world();
    await env.THUMBNAILS.put('thumbnails/s_x.jpg', new Uint8Array(4));
    for (const path of [
      `9.9.9/${helperFileName('9.9.9', 'tarball')}`,
      `${VERSION}/latest.json`,
      `${VERSION}/..%2Flatest.json`,
      `..%2Fthumbnails/s_x.jpg`,
    ]) {
      const res = await download(path, w.member);
      expect(res.status, path).toBe(404);
      await res.arrayBuffer();
    }
  });

  it('limits downloads per person', async () => {
    const w = await world();
    await env.THUMBNAILS.put(helperFileKey(VERSION, 'SHA256SUMS'), 'x');
    for (let i = 0; i < DOWNLOADS_PER_HOUR; i++) {
      const res = await download(`${VERSION}/SHA256SUMS`, w.member2);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    const res = await download(`${VERSION}/SHA256SUMS`, w.member2);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe('rate_limited');
    // Someone else still can.
    const other = await download(`${VERSION}/SHA256SUMS`, w.member);
    expect(other.status).toBe(200);
    await other.arrayBuffer();
  });
});
