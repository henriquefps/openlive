// SPDX-License-Identifier: AGPL-3.0-only
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseRoomCode } from '../src/api/rooms';
import { cookieName, SESSION_COOKIE } from '../src/auth/cookies';
import { createSession } from '../src/auth/session';
import { auditRows, call, type Json, migrate, newUser, world, type World } from './api-helpers';
import { Client } from './room-helpers';

beforeAll(migrate);
afterEach(() => vi.restoreAllMocks());

// The app origin in vitest.config.ts (APP_ORIGIN).
const ORIGIN = 'https://openlive.example';

async function quickRoom(w: World): Promise<{ id: string; code: string; expiresAt: number }> {
  const res = await call('POST', '/rooms/quick', w.member, { spaceId: w.spaceId });
  if (res.status !== 201) throw new Error(`quick room failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.room.id, code: res.body.code, expiresAt: res.body.room.expiresAt };
}

const join = (userId: string, code: string) => call('POST', '/rooms/join', userId, { code });

/** A request from a remote IP: the development identity only works locally, so a session. */
async function joinFromIp(userId: string, code: string, ip: string) {
  const { token } = await createSession(new Request('http://localhost/'), env, userId);
  const res = await exports.default.fetch(`${ORIGIN}/api/rooms/join`, {
    method: 'POST',
    headers: {
      Cookie: `${cookieName(SESSION_COOKIE, ORIGIN)}=${token}`,
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify({ code }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

describe('parseRoomCode', () => {
  it('accepts the code in any case, with or without OL, spaces or hyphens', () => {
    for (const input of ['OL-4821-0937', 'ol-4821-0937', 'ol48210937', '4821 0937', ' 48210937 ']) {
      expect(parseRoomCode(input)).toBe('OL-4821-0937');
    }
  });

  it('refuses anything that cannot be a code', () => {
    for (const input of ['', 'OL-4821', '4821', '4821-093', 'OL-4821-09370', 'XX-4821-0937']) {
      expect(parseRoomCode(input)).toBeNull();
    }
  });
});

describe('POST /api/rooms/join', () => {
  it('lets an outsider in as a guest of that room only, until the room expires', async () => {
    const w = await world();
    const room = await quickRoom(w);
    const compact = room.code.replaceAll('-', '').toLowerCase();

    const res = await join(w.outsider, compact);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: 'guest', granted: true, spaceSlug: null });
    expect(res.body.room).toMatchObject({ id: room.id, code: room.code, kind: 'quick' });

    const grant = await env.DB.prepare(
      'SELECT can_view, can_stream, granted_by, expires_at FROM room_access WHERE room_id = ? AND user_id = ?',
    )
      .bind(room.id, w.outsider)
      .first();
    expect(grant).toEqual({
      can_view: 1,
      can_stream: 0,
      granted_by: w.member,
      expires_at: room.expiresAt,
    });
    expect(await auditRows(w.spaceId, 'room.join_code')).toEqual([
      expect.objectContaining({ actor_id: w.outsider, target: room.id }),
    ]);

    // The room opens, the space stays hidden.
    expect((await call('GET', `/rooms/${room.id}`, w.outsider)).status).toBe(200);
    expect((await call('GET', `/spaces/${w.spaceId}`, w.outsider)).status).toBe(404);
    const { client, welcome } = await Client.join(room.id, w.outsider);
    expect(welcome.you.role).toBe('guest');
    client.close();

    // Joining again gives nothing new and keeps the grant.
    expect((await join(w.outsider, room.code)).body).toMatchObject({ granted: false });
  });

  it('members enter with their own role and get no grant', async () => {
    const w = await world();
    const room = await quickRoom(w);
    for (const [user, role] of [
      [w.owner, 'owner'],
      [w.member2, 'member'],
      [w.guest, 'guest'],
    ] as const) {
      const res = await join(user, room.code);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ role, granted: false, spaceSlug: expect.any(String) });
    }
    const { results } = await env.DB.prepare('SELECT user_id FROM room_access WHERE room_id = ?')
      .bind(room.id)
      .all();
    expect(results).toEqual([]);
  });

  it('refuses a wrong code, a closed room, a banned member and a restricted room', async () => {
    const w = await world();
    const user = await newUser('joiner');
    expect(await join(user, 'hello')).toEqual({ status: 400, body: { code: 'room_code_invalid' } });
    expect(await join(user, 'OL-0000-0000')).toEqual({
      status: 404,
      body: { code: 'room_code_invalid' },
    });

    const expired = await quickRoom(w);
    await join(user, expired.code);
    await env.DB.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, expired.id)
      .run();
    expect(await join(await newUser('late'), expired.code)).toEqual({
      status: 410,
      body: { code: 'room_closed', roomId: expired.id },
    });
    // The guest's access ended with the room.
    expect((await call('GET', `/rooms/${expired.id}`, user)).status).toBe(410);

    const ended = await quickRoom(w);
    expect((await call('DELETE', `/rooms/${ended.id}`, w.member)).status).toBe(204);
    expect((await join(user, ended.code)).body).toEqual({ code: 'room_closed', roomId: ended.id });

    const room = await quickRoom(w);
    await call('POST', `/spaces/${w.spaceId}/members/${w.member2}/ban`, w.admin);
    expect(await join(w.member2, room.code)).toEqual({
      status: 403,
      body: { code: 'banned', spaceId: w.spaceId },
    });

    await call('PATCH', `/rooms/${room.id}`, w.owner, { visibility: 'restricted' });
    expect(await join(w.outsider, room.code)).toEqual({
      status: 403,
      body: { code: 'forbidden', roomId: room.id },
    });
  });

  it('limits attempts per user, counting every attempt', async () => {
    const w = await world();
    const room = await quickRoom(w);
    const user = await newUser('guesser');
    for (let i = 0; i < 9; i++) {
      expect((await join(user, `OL-0000-${String(i).padStart(4, '0')}`)).status).toBe(404);
    }
    expect((await join(user, room.code)).status).toBe(200);
    const res = await join(user, room.code);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ code: 'rate_limited', retryAfterMs: expect.any(Number) });
    expect(res.body.retryAfterMs).toBeGreaterThan(0);
    // Someone else is not affected.
    expect((await join(w.outsider, room.code)).status).toBe(200);
  });

  it('limits attempts per IP across users', async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < 3; i++) {
      const user = await newUser(`ip${i}`);
      for (let j = 0; j < 10; j++) {
        expect((await joinFromIp(user, 'OL-0000-0001', ip)).status).toBe(404);
      }
    }
    const res = await joinFromIp(await newUser('ip-last'), 'OL-0000-0001', ip);
    expect(res.status).toBe(429);
    expect((await joinFromIp(await newUser('elsewhere'), 'OL-0000-0001', '192.0.2.1')).status).toBe(
      404,
    );
  });
});

describe('quick room codes', () => {
  it('are unique among open rooms across spaces; creation draws again on a collision', async () => {
    const a = await world();
    const b = await world();
    const first = await quickRoom(a);
    const taken = Number(first.code.replace(/\D/g, ''));
    const next = (taken + 1) % 100_000_000;
    // The first draw repeats the taken code, the second one is free.
    const draws = [taken, next];
    const real = crypto.getRandomValues.bind(crypto);
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      const value = draws.shift();
      if (value === undefined || !(array instanceof Uint32Array)) return real(array);
      array[0] = value;
      return array;
    });
    const second = await quickRoom(b);
    vi.restoreAllMocks();
    expect(second.code).toBe(
      `OL-${String(next).padStart(8, '0').slice(0, 4)}-${String(next).padStart(8, '0').slice(4)}`,
    );
    expect((await join(b.owner, first.code)).body.room.id).toBe(first.id);

    // An archived room frees its code.
    await call('DELETE', `/rooms/${first.id}`, a.member);
    const reuse = env.DB.prepare(
      `INSERT INTO rooms (id, space_id, kind, name, slug, code, created_at, expires_at)
       VALUES (?, ?, 'quick', 'R', ?, ?, ?, ?)`,
    );
    const now = Date.now();
    await reuse.bind(`rm_reuse_${now}`, b.spaceId, `reuse-${now}`, first.code, now, now + 1).run();
    await expect(
      reuse.bind(`rm_dup_${now}`, a.spaceId, `dup-${now}`, first.code, now, now + 1).run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('only quick rooms have one', async () => {
    const w = await world();
    const now = Date.now();
    await expect(
      env.DB.prepare(
        `INSERT INTO rooms (id, space_id, kind, name, slug, code, created_at)
         VALUES (?, ?, 'fixed', 'R', 'r', 'OL-1111-2222', ?)`,
      )
        .bind(`rm_fixed_${now}`, w.spaceId, now)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });
});
