// SPDX-License-Identifier: AGPL-3.0-only
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { AVATAR_UPLOADS_PER_HOUR, MAX_AVATAR_BYTES } from '../src/api/avatars';
import { avatarKey } from '../src/db/avatars';
import { DEV_USER_HEADER } from '../src/room/identity';
import { addMember, call, fixedRoom, migrate, newUser, world } from './api-helpers';

// Profile photos (Settings -> Profile; src/api/avatars.ts): upload checks, who may see a photo,
// versioned URLs, removing it and going back to the Discord photo.

beforeAll(migrate);

const WEBP = new Uint8Array([
  ...new TextEncoder().encode('RIFF'),
  ...[0x24, 0, 0, 0],
  ...new TextEncoder().encode('WEBPVP8 '),
  ...new Array<number>(24).fill(0),
]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0, 0, 0, 0, 0, 0]);

function upload(userId: string | undefined, bytes: Uint8Array, type = 'image/webp') {
  return exports.default.fetch('http://localhost/api/me/avatar', {
    method: 'PUT',
    headers: { ...(userId ? { [DEV_USER_HEADER]: userId } : {}), 'Content-Type': type },
    body: bytes,
  });
}

function view(path: string, userId?: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(`http://localhost${path}`, {
    headers: { ...(userId ? { [DEV_USER_HEADER]: userId } : {}), ...headers },
  });
}

async function uploaded(userId: string, bytes = WEBP, type = 'image/webp'): Promise<string> {
  const res = await upload(userId, bytes, type);
  expect(res.status).toBe(200);
  const body = await res.json<{ user: { avatarUrl: string }; avatar: unknown }>();
  expect(body.avatar).toEqual({ source: 'upload', discordAvailable: false });
  return body.user.avatarUrl;
}

describe('PUT /api/me/avatar', () => {
  it('needs a signed-in user', async () => {
    expect((await upload(undefined, WEBP)).status).toBe(401);
  });

  it('stores the photo in R2 and points avatarUrl at a versioned URL', async () => {
    const user = await newUser('photo');
    const url = await uploaded(user);
    expect(url).toMatch(new RegExp(`^/api/avatars/${user}/[a-z0-9]+$`));
    const object = await env.THUMBNAILS.get(avatarKey(user));
    expect(object?.httpMetadata?.contentType).toBe('image/webp');
    expect(new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(WEBP);
    expect((await call('GET', '/me', user)).body.user.avatarUrl).toBe(url);
  });

  it('accepts PNG and JPEG too, by their first bytes', async () => {
    const user = await newUser('formats');
    await uploaded(user, PNG, 'image/png');
    await uploaded(user, JPEG, 'image/jpeg');
    expect((await env.THUMBNAILS.get(avatarKey(user)))?.httpMetadata?.contentType).toBe(
      'image/jpeg',
    );
  });

  it('refuses other types, and bytes that do not match the type (415)', async () => {
    const user = await newUser('types');
    for (const [bytes, type] of [
      [WEBP, 'image/gif'],
      [WEBP, 'image/svg+xml'],
      [WEBP, 'application/json'],
      [PNG, 'image/webp'],
      [new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'],
      [new Uint8Array([0xff, 0xd8]), 'image/jpeg'],
    ] as const) {
      const res = await upload(user, bytes, type);
      expect(res.status, type).toBe(415);
      expect(await res.json()).toEqual({ code: 'invalid_message', path: '' });
    }
    expect(await env.THUMBNAILS.get(avatarKey(user))).toBeNull();
  });

  it('refuses photos over the size limit (413)', async () => {
    const user = await newUser('big');
    const big = new Uint8Array(MAX_AVATAR_BYTES + 1);
    big.set(WEBP);
    const res = await upload(user, big);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      code: 'invalid_message',
      path: '',
      limit: MAX_AVATAR_BYTES,
    });
  });

  it('limits uploads per hour (429)', async () => {
    const user = await newUser('many');
    for (let i = 0; i < AVATAR_UPLOADS_PER_HOUR; i++) {
      expect((await upload(user, WEBP)).status).toBe(200);
    }
    const res = await upload(user, WEBP);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'rate_limited' });
  });
});

describe('GET /api/avatars/:userId/:version', () => {
  it('serves the photo to people who share a space, the owner and the platform admin', async () => {
    const w = await world();
    const url = await uploaded(w.member);
    const admin = await newUser('padmin', { platformAdmin: true });
    for (const who of [w.member, w.owner, w.member2, w.guest, admin]) {
      const res = await view(url, who);
      expect(res.status, who).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/webp');
      expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(WEBP);
    }
  });

  it('serves a room guest of the space, and answers 304 to a known ETag', async () => {
    const w = await world();
    const roomId = await fixedRoom(w);
    const roomGuest = await newUser('roomguest');
    await env.DB.prepare(
      'INSERT INTO room_access (room_id, user_id, can_view, granted_at) VALUES (?, ?, 1, ?)',
    )
      .bind(roomId, roomGuest, Date.now())
      .run();
    const url = await uploaded(w.owner);
    const first = await view(url, roomGuest);
    expect(first.status).toBe(200);
    const etag = first.headers.get('ETag') ?? '';
    expect((await view(url, roomGuest, { 'If-None-Match': etag })).status).toBe(304);
  });

  it('is 404 for outsiders, banned members, old versions and bad ids; 401 signed out', async () => {
    const w = await world();
    const url = await uploaded(w.member);
    const banned = await newUser('banned');
    await addMember(w.spaceId, banned, 'member');
    await env.DB.prepare('UPDATE space_members SET banned_at = ? WHERE user_id = ?')
      .bind(Date.now(), banned)
      .run();
    expect((await view(url)).status).toBe(401);
    for (const who of [w.outsider, banned]) {
      const res = await view(url, who);
      expect(res.status, who).toBe(404);
      expect(await res.json()).toEqual({ code: 'not_found' });
    }
    // A new upload is a new URL: the old one is no longer served.
    await new Promise((r) => setTimeout(r, 5));
    const next = await uploaded(w.member);
    expect(next).not.toBe(url);
    expect((await view(url, w.owner)).status).toBe(404);
    expect((await view(next, w.owner)).status).toBe(200);
    expect((await view(`/api/avatars/${w.member}/NOT-A-VERSION`, w.owner)).status).toBe(404);
    expect((await view(`/api/avatars/bad%20id/abc`, w.owner)).status).toBe(404);
  });

  it('is 404 when the space is suspended', async () => {
    const w = await world();
    const url = await uploaded(w.member);
    await env.DB.prepare('UPDATE spaces SET suspended_at = ? WHERE id = ?')
      .bind(Date.now(), w.spaceId)
      .run();
    expect((await view(url, w.owner)).status).toBe(404);
    expect((await view(url, w.member)).status).toBe(200);
  });
});

describe('DELETE /api/me/avatar and POST /api/me/avatar/discord', () => {
  it('removes the photo: initials, the R2 object gone, the old URL 404', async () => {
    const w = await world();
    const url = await uploaded(w.member);
    expect((await call('DELETE', '/me/avatar')).status).toBe(401);
    const res = await call('DELETE', '/me/avatar', w.member);
    expect(res.status).toBe(200);
    expect(res.body.user.avatarUrl).toBeNull();
    expect(res.body.avatar).toEqual({ source: 'none', discordAvailable: false });
    expect(await env.THUMBNAILS.get(avatarKey(w.member))).toBeNull();
    expect((await view(url, w.owner)).status).toBe(404);
  });

  it('goes back to the Discord photo, or 404 when there is none', async () => {
    const user = await newUser('discord');
    expect(await call('POST', '/me/avatar/discord', user)).toEqual({
      status: 404,
      body: { code: 'not_found' },
    });
    const discord = 'https://cdn.discordapp.com/avatars/1/abc.png?size=128';
    await env.DB.prepare('UPDATE users SET avatar_url = ?1, discord_avatar_url = ?1 WHERE id = ?2')
      .bind(discord, user)
      .run();
    expect((await call('GET', '/me', user)).body.avatar).toEqual({
      source: 'discord',
      discordAvailable: true,
    });
    const up = await upload(user, WEBP);
    expect((await up.json<{ avatar: unknown }>()).avatar).toEqual({
      source: 'upload',
      discordAvailable: true,
    });
    const res = await call('POST', '/me/avatar/discord', user);
    expect(res.status).toBe(200);
    expect(res.body.user.avatarUrl).toBe(discord);
    expect(res.body.avatar).toEqual({ source: 'discord', discordAvailable: true });
    expect(await env.THUMBNAILS.get(avatarKey(user))).toBeNull();
  });
});

describe('account deletion', () => {
  it('deletes the uploaded photo with the account', async () => {
    const user = await newUser('leaving');
    await uploaded(user);
    const admin = await newUser('padmin', { platformAdmin: true });
    expect((await call('DELETE', `/admin/users/${user}`, admin)).status).toBe(204);
    expect(await env.THUMBNAILS.get(avatarKey(user))).toBeNull();
    const row = await env.DB.prepare(
      'SELECT avatar_url, discord_avatar_url, avatar_source FROM users WHERE id = ?',
    )
      .bind(user)
      .first();
    expect(row).toEqual({ avatar_url: null, discord_avatar_url: null, avatar_source: null });
  });
});
