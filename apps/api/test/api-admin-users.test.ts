// SPDX-License-Identifier: AGPL-3.0-only
import type { PayloadOf } from '@openlive/protocol';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { identityHash } from '../src/auth/bans';
import { setEmailSenderForTests } from '../src/auth/email';
import { DELETION_TABLES } from '../src/db/admin-users';
import { randomToken, sha256Hex } from '../src/db/util';
import { DEV_DEVICE_HEADER, DEV_USER_HEADER } from '../src/room/identity';
import type { RoomStream } from '../src/room/types';
import { addMember, call, fixedRoom, migrate, newUser, world } from './api-helpers';
import {
  discordLogin,
  discordUser,
  FakeSender,
  location,
  newEmail,
  send,
  setCookies,
  verify,
} from './auth-helpers';
import { Client, roomStub, upgrade } from './room-helpers';

// Platform user management: the list and detail, the platform ban and
// its enforcement (login, sign-up, sockets, streams), sign-out and unpairing without a ban, and
// deletion with its exact scope. Sign-up is open here (migrate()), so a refusal is the ban's.

let mail: FakeSender;

beforeAll(migrate);
beforeEach(() => {
  mail = new FakeSender();
  setEmailSenderForTests(mail);
});
afterEach(() => {
  setEmailSenderForTests(null);
  vi.restoreAllMocks();
});

const u = (userId: string) => `/admin/users/${userId}`;

// --- fixtures -------------------------------------------------------------------------------

/** A signed-in browser: a session row and its cookie token. */
async function session(userId: string, userAgent = 'Firefox/140'): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip_hash)
     VALUES (?, ?, ?, ?, ?, 'iphash-secret')`,
  )
    .bind(await sha256Hex(token), userId, now, now + 86_400_000, userAgent)
    .run();
  return token;
}

/** A paired helper: a device row and its bearer token. */
async function device(userId: string): Promise<{ id: string; token: string }> {
  const token = randomToken();
  const id = `d_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO devices (id, user_id, name, os, arch, helper_version, token_hash, created_at)
     VALUES (?, ?, 'Desk PC', 'linux', 'amd64', '0.1.0', ?, ?)`,
  )
    .bind(id, userId, await sha256Hex(token), Date.now())
    .run();
  return { id, token };
}

async function identity(userId: string, provider: 'discord' | 'email', value: string) {
  await env.DB.prepare(
    `INSERT INTO identities (id, user_id, provider, provider_user_id, email, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `id_${crypto.randomUUID().slice(0, 8)}`,
      userId,
      provider,
      value,
      provider === 'email' ? value : null,
      Date.now(),
    )
    .run();
}

const withSession = (token: string) => send('/api/me', { cookies: { '__Host-ol_session': token } });
/** A route a device token may call (the helper's room settings): 404 when live, 401 when not. */
const withDevice = (token: string) =>
  send('/api/rooms/r_missing', { headers: { Authorization: `Bearer ${token}` } });

function stream(streamId: string, userId: string, deviceId: string): RoomStream {
  return {
    streamId,
    userId,
    deviceId,
    source: { kind: 'window', label: 'Secret window title' },
    preset: 'game',
    hasAudio: true,
    paused: false,
    startedAt: Date.now(),
    viewerLimit: 4,
  };
}

const PROTOCOL = { major: 1, minor: 9 };

async function hubTab(userId: string): Promise<Client> {
  const res = await exports.default.fetch('http://localhost/ws/hub', {
    headers: { Upgrade: 'websocket', [DEV_USER_HEADER]: userId },
  });
  const client = Client.adopt(res);
  const reply = await client.request('hello', {
    protocol: PROTOCOL,
    client: 'web',
    clientVersion: '0.0.0',
    tabId: `t_${crypto.randomUUID().slice(0, 8)}`,
  } satisfies PayloadOf<'hello'>);
  expect(reply.type).toBe('hub.welcome');
  return client;
}

async function hubHelper(userId: string, deviceId: string): Promise<Client> {
  const res = await exports.default.fetch('http://localhost/ws/hub', {
    headers: { Upgrade: 'websocket', [DEV_USER_HEADER]: userId, [DEV_DEVICE_HEADER]: deviceId },
  });
  const client = Client.adopt(res);
  const reply = await client.request('hello', {
    protocol: PROTOCOL,
    client: 'helper',
    clientVersion: '0.2.0',
    deviceId,
  });
  expect(reply.type).toBe('hub.welcome');
  return client;
}

const platformAudit = (action: string, target: string) =>
  env.DB.prepare(
    `SELECT actor_id, target, data_json FROM audit_log
     WHERE space_id IS NULL AND action = ? AND target = ?`,
  )
    .bind(action, target)
    .all<{ actor_id: string | null; target: string; data_json: string }>()
    .then((r) => r.results.map((row) => ({ ...row, data: JSON.parse(row.data_json) })));

// --- authorization --------------------------------------------------------------------------

describe('who may manage users', () => {
  it('answers 401 to anonymous callers and 403 to everyone but the platform admin', async () => {
    const w = await world();
    const routes: [string, string, unknown?][] = [
      ['GET', '/admin/users'],
      ['GET', u(w.member)],
      ['POST', `${u(w.member)}/ban`, {}],
      ['POST', `${u(w.member)}/unban`],
      ['POST', `${u(w.member)}/sessions/revoke`],
      ['POST', `${u(w.member)}/devices/revoke`],
      ['DELETE', u(w.member)],
    ];
    for (const [method, path, body] of routes) {
      expect((await call(method, path, undefined, body)).status).toBe(401);
      // A space owner is not a platform admin.
      expect(await call(method, path, w.owner, body)).toEqual({
        status: 403,
        body: { code: 'forbidden' },
      });
    }
    // Nothing changed.
    expect((await call('GET', '/me', w.member)).status).toBe(200);
  });

  it('does not reveal whether a user id exists to a non-admin', async () => {
    const nosy = await newUser('nosy');
    expect((await call('GET', u('u_unknown'), nosy)).status).toBe(403);
    const admin = await newUser('admin', { platformAdmin: true });
    expect(await call('GET', u('u_unknown'), admin)).toEqual({
      status: 404,
      body: { code: 'user_not_found', userId: 'u_unknown' },
    });
  });
});

// --- list and detail ------------------------------------------------------------------------

describe('GET /api/admin/users', () => {
  it('lists accounts with their spaces, roles and space bans; e-mail only for the admin', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    await env.DB.prepare('UPDATE users SET primary_email = ? WHERE id = ?')
      .bind(`${w.member}@example.com`, w.member)
      .run();
    await identity(w.member, 'discord', `d-${w.member}`);
    await device(w.member);
    await env.DB.prepare(
      'UPDATE space_members SET banned_at = ? WHERE space_id = ? AND user_id = ?',
    )
      .bind(Date.now(), w.spaceId, w.member2)
      .run();

    const res = await call('GET', `/admin/users?query=${encodeURIComponent(w.member)}`, admin);
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([
      {
        id: w.member,
        displayName: 'Name member',
        avatarUrl: null,
        primaryEmail: `${w.member}@example.com`,
        providers: ['discord'],
        isPlatformAdmin: false,
        createdAt: expect.any(Number),
        lastSeenAt: null,
        bannedAt: null,
        deviceCount: 1,
        spaces: [
          {
            id: w.spaceId,
            name: 'Friends',
            slug: expect.any(String),
            role: 'member',
            bannedAt: null,
          },
        ],
      },
    ]);
    const banned = await call('GET', `/admin/users?query=${w.member2}`, admin);
    expect(banned.body.users[0].spaces[0]).toMatchObject({ bannedAt: expect.any(Number) });
  });

  it('searches names and e-mails, and filters: no space, banned, admins', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    const tag = crypto.randomUUID().slice(0, 8);
    const lonely = await newUser(`lonely${tag}`);
    await env.DB.prepare('UPDATE users SET primary_email = ? WHERE id = ?')
      .bind(`Find.${tag}@Example.com`, w.member)
      .run();

    const ids = async (qs: string) =>
      (await call('GET', `/admin/users?${qs}`, admin)).body.users.map((x: { id: string }) => x.id);

    expect(await ids(`query=LONELY${tag}`)).toEqual([lonely]);
    expect(await ids(`query=find.${tag}`)).toEqual([w.member]);
    // `%` and `_` are not wildcards.
    expect(await ids(`query=${encodeURIComponent('%')}${tag}`)).toEqual([]);

    const noSpace = await ids('filter=no_space');
    expect(noSpace).toContain(lonely);
    expect(noSpace).toContain(w.outsider);
    for (const attached of [w.owner, w.member, w.guest, admin]) {
      expect(noSpace).not.toContain(attached);
    }
    const admins = await ids('filter=admins');
    expect(admins).toContain(admin);
    expect(admins).not.toContain(w.owner);

    await call('POST', `${u(lonely)}/ban`, admin, {});
    const banned = await ids('filter=banned');
    expect(banned).toContain(lonely);
    expect(banned).not.toContain(w.member);

    expect((await call('GET', '/admin/users?filter=nope', admin)).body).toEqual({
      code: 'invalid_message',
      path: '/filter',
    });
    expect((await call('GET', '/admin/users?cursor=bad', admin)).body).toEqual({
      code: 'invalid_message',
      path: '/cursor',
    });
  });

  it('pages newest first with a cursor', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const tag = `pg${crypto.randomUUID().slice(0, 6)}`;
    const made: string[] = [];
    for (let i = 0; i < 53; i++) {
      const id = `u_${tag}_${String(i).padStart(2, '0')}`;
      await env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
        .bind(id, `${tag} ${i}`, 1_000 + i)
        .run();
      made.push(id);
    }
    const first = await call('GET', `/admin/users?query=${tag}`, admin);
    expect(first.body.users).toHaveLength(50);
    expect(first.body.users[0].id).toBe(made[52]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await call(
      'GET',
      `/admin/users?query=${tag}&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      admin,
    );
    expect(second.body.users.map((x: { id: string }) => x.id)).toEqual([made[2], made[1], made[0]]);
    expect(second.body.nextCursor).toBeNull();
  });
});

describe('GET /api/admin/users/:userId', () => {
  it('shows sessions without IPs, devices, activity and live streams as metadata only', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    const roomId = await fixedRoom(w);
    await session(w.member, 'Mozilla/5.0 Firefox/140');
    const d = await device(w.member);
    await call('PATCH', `/spaces/${w.spaceId}/members/${w.member}`, w.owner, { role: 'admin' });
    const { client } = await Client.join(roomId, w.member);
    await roomStub(roomId).upsertStream(stream('st_detail', w.member, d.id));

    const res = await call('GET', u(w.member), admin);
    expect(res.status).toBe(200);
    const user = res.body.user;
    expect(user.sessions).toEqual([
      {
        id: expect.any(String),
        createdAt: expect.any(Number),
        lastSeenAt: expect.any(Number),
        expiresAt: expect.any(Number),
        userAgent: 'Mozilla/5.0 Firefox/140',
      },
    ]);
    expect(user.devices).toEqual([expect.objectContaining({ deviceId: d.id, name: 'Desk PC' })]);
    expect(user.streams).toEqual([
      {
        streamId: 'st_detail',
        preset: 'game',
        sourceKind: 'window',
        startedAt: expect.any(Number),
        viewerCount: 0,
        roomId,
        roomName: 'Game night',
        spaceId: w.spaceId,
        spaceName: 'Friends',
      },
    ]);
    // Never the IP hash, never the content (the source's label is a window title).
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('iphash-secret');
    expect(text).not.toContain('Secret window title');
    expect(user.audit.length).toBeGreaterThan(0);
    expect(user.audit[0]).toMatchObject({ spaceId: w.spaceId, spaceName: 'Friends' });
    client.ws.close();
  });
});

// --- ban ------------------------------------------------------------------------------------

describe('POST /api/admin/users/:userId/ban', () => {
  it('refuses the admin themselves; bans another admin while one remains', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const other = await newUser('admin2', { platformAdmin: true });
    expect(await call('POST', `${u(admin)}/ban`, admin, {})).toEqual({
      status: 409,
      body: { code: 'cannot_target_self', userId: admin },
    });
    expect(await call('DELETE', u(admin), admin)).toEqual({
      status: 409,
      body: { code: 'cannot_target_self', userId: admin },
    });
    expect((await call('POST', `${u(other)}/ban`, admin, {})).status).toBe(200);
    expect(await platformAudit('platform.user.ban', admin)).toEqual([]);
  });

  it('bans: no session, device or dev login works, identities recorded, audited once', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    const email = newEmail();
    await identity(w.member, 'email', email);
    await identity(w.member, 'discord', `d-${w.member}`);
    const cookie = await session(w.member);
    const d = await device(w.member);
    expect((await withSession(cookie)).status).toBe(200);
    expect((await withDevice(d.token)).status).toBe(404);

    const res = await call('POST', `${u(w.member)}/ban`, admin, { reason: '  spam  ' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      bannedAt: expect.any(Number),
      bannedReason: 'spam',
      bannedBy: admin,
      sessions: [],
      devices: [],
    });
    expect((await withSession(cookie)).status).toBe(401);
    expect((await withDevice(d.token)).status).toBe(401);
    expect((await call('GET', '/me', w.member)).status).toBe(401);
    expect((await upgrade(await fixedRoom(w), w.member)).status).toBe(401);

    const hashes = await env.DB.prepare(
      'SELECT identity_hash FROM banned_identities WHERE user_id = ? ORDER BY identity_hash',
    )
      .bind(w.member)
      .all<{ identity_hash: string }>();
    expect(hashes.results.map((r) => r.identity_hash)).toEqual(
      [await identityHash('email', email), await identityHash('discord', `d-${w.member}`)].sort(),
    );
    // Stored as hashes only.
    expect(JSON.stringify(hashes.results)).not.toContain(email);

    // Again: nothing more happens.
    expect((await call('POST', `${u(w.member)}/ban`, admin, {})).status).toBe(200);
    expect(await platformAudit('platform.user.ban', w.member)).toEqual([
      expect.objectContaining({ actor_id: admin, data: { reason: 'spam' } }),
    ]);
  });

  it('closes room sockets (4004 banned) and hub sockets (4001), ends streams, frees slots', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    const roomId = await fixedRoom(w);
    const d = await device(w.member);
    const web = await Client.join(roomId, w.member);
    const helper = await Client.join(roomId, w.member, { client: 'helper', deviceId: d.id });
    const watcher = await Client.join(roomId, w.member2);
    const tab = await hubTab(w.member);
    const hubHelperSocket = await hubHelper(w.member, d.id);
    // The member streams; member2 holds a slot of another stream the member watches too.
    await roomStub(roomId).upsertStream(stream('st_banned', w.member, d.id));
    await roomStub(roomId).upsertStream(stream('st_other', w.member2, 'd_other'));
    const slot = await web.client.request('slot.request', { streamId: 'st_other' });
    expect(slot.type).toBe('slot.granted');

    expect((await call('POST', `${u(w.member)}/ban`, admin, {})).status).toBe(200);

    for (const { client } of [web, helper]) {
      expect((await client.take('kicked')).payload).toEqual({ reason: 'banned' });
      expect((await client.closed).code).toBe(4004);
    }
    for (const client of [tab, hubHelperSocket]) {
      expect((await client.take('error')).payload).toEqual({ code: 'session_expired' });
      expect((await client.closed).code).toBe(4001);
    }
    expect(
      (await watcher.client.take('stream.ended', (m) => m.payload.streamId === 'st_banned'))
        .payload,
    ).toEqual({ streamId: 'st_banned', reason: 'permission_revoked' });
    expect(await roomStub(roomId).streamsOf(w.member)).toEqual([]);
    // The banned viewer's slot went with the socket.
    const viewers = await watcher.client.drain('viewers');
    expect(viewers.filter((m) => m.payload.streamId === 'st_other').at(-1)?.payload).toMatchObject({
      used: 0,
      viewerUserIds: [],
    });
    watcher.client.ws.close();
  });
});

describe('ban enforcement at login and sign-up', () => {
  it('refuses a banned Discord account, and a new sign-up with its Discord id or e-mail', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const email = newEmail();
    const person = discordUser({ email, verified: true });
    const first = await discordLogin(person);
    expect(setCookies(first.res)['__Host-ol_session']).toBeDefined();
    const userId = (await env.DB.prepare(
      "SELECT user_id FROM identities WHERE provider = 'discord' AND provider_user_id = ?",
    )
      .bind(person.id)
      .first<string>('user_id')) as string;
    expect((await call('POST', `${u(userId)}/ban`, admin, {})).status).toBe(200);
    vi.restoreAllMocks();

    const refused = await discordLogin(person);
    expect(location(refused.res).searchParams.get('authError')).toBe('account_banned');
    expect(setCookies(refused.res)['__Host-ol_session']).toBeUndefined();

    // Deleted with the ban kept: the same Discord account, or another one with the same verified
    // e-mail, cannot sign up again.
    expect((await call('DELETE', u(userId), admin, { ban: true })).status).toBe(204);
    vi.restoreAllMocks();
    const again = await discordLogin(person);
    expect(location(again.res).searchParams.get('authError')).toBe('account_banned');
    vi.restoreAllMocks();
    const sameEmail = await discordLogin(discordUser({ email, verified: true }));
    expect(location(sameEmail.res).searchParams.get('authError')).toBe('account_banned');
    const created = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM identities WHERE provider = 'discord' AND provider_user_id = ?",
    )
      .bind(person.id)
      .first<number>('n');
    expect(created).toBe(0);
  });

  it('refuses a banned e-mail: nothing sent, and a link sent before the ban is refused', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const email = newEmail();
    expect((await send('/api/auth/email/start', { method: 'POST', body: { email } })).status).toBe(
      202,
    );
    const signedUp = await verify(mail.lastToken());
    expect(setCookies(signedUp)['__Host-ol_session']).toBeDefined();
    const userId = (await env.DB.prepare('SELECT id FROM users WHERE primary_email = ?')
      .bind(email)
      .first<string>('id')) as string;

    // A link asked for before the ban, used after it.
    await send('/api/auth/email/start', { method: 'POST', body: { email } });
    const early = mail.lastToken();
    expect((await call('POST', `${u(userId)}/ban`, admin, {})).status).toBe(200);
    const late = await verify(early);
    expect(location(late).searchParams.get('authError')).toBe('account_banned');
    expect(setCookies(late)['__Host-ol_session']).toBeUndefined();

    const sent = mail.sent.length;
    expect((await send('/api/auth/email/start', { method: 'POST', body: { email } })).status).toBe(
      202,
    );
    expect(mail.sent.length).toBe(sent);

    // Deleted and banned: the address does not sign up again (in any case).
    expect((await call('DELETE', u(userId), admin, { ban: true })).status).toBe(204);
    await send('/api/auth/email/start', { method: 'POST', body: { email: email.toUpperCase() } });
    expect(mail.sent.length).toBe(sent);
  });

  it('unban frees the account and its identities; deletion without a ban frees the address', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const email = newEmail();
    await send('/api/auth/email/start', { method: 'POST', body: { email } });
    await verify(mail.lastToken());
    const userId = (await env.DB.prepare('SELECT id FROM users WHERE primary_email = ?')
      .bind(email)
      .first<string>('id')) as string;
    await call('POST', `${u(userId)}/ban`, admin, { reason: 'oops' });

    const res = await call('POST', `${u(userId)}/unban`, admin);
    expect(res.body.user).toMatchObject({ bannedAt: null, bannedReason: null, bannedBy: null });
    const left = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM banned_identities WHERE user_id = ?',
    )
      .bind(userId)
      .first<number>('n');
    expect(left).toBe(0);
    await send('/api/auth/email/start', { method: 'POST', body: { email } });
    expect(setCookies(await verify(mail.lastToken()))['__Host-ol_session']).toBeDefined();
    expect(await platformAudit('platform.user.unban', userId)).toHaveLength(1);

    expect((await call('DELETE', u(userId), admin)).status).toBe(204);
    await send('/api/auth/email/start', { method: 'POST', body: { email } });
    const fresh = await verify(mail.lastToken());
    expect(setCookies(fresh)['__Host-ol_session']).toBeDefined();
    const newId = await env.DB.prepare(
      'SELECT id FROM users WHERE primary_email = ? AND deleted_at IS NULL',
    )
      .bind(email)
      .first<string>('id');
    expect(newId).not.toBe(userId);
  });
});

// --- sign out and unpair without a ban -----------------------------------------------------

describe('revoking sessions and devices without a ban', () => {
  it('signs every browser out and unpairs every helper (4001), audited, account still usable', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    const roomId = await fixedRoom(w);
    const [s1, s2] = [await session(w.member), await session(w.member)];
    const d = await device(w.member);
    const helper = await Client.join(roomId, w.member, { client: 'helper', deviceId: d.id });
    await roomStub(roomId).upsertStream(stream('st_dev', w.member, d.id));

    expect(await call('POST', `${u(w.member)}/sessions/revoke`, admin)).toEqual({
      status: 200,
      body: { revoked: 2 },
    });
    expect((await withSession(s1)).status).toBe(401);
    expect((await withSession(s2)).status).toBe(401);
    expect((await withDevice(d.token)).status).toBe(404);

    expect(await call('POST', `${u(w.member)}/devices/revoke`, admin)).toEqual({
      status: 200,
      body: { revoked: 1 },
    });
    expect((await withDevice(d.token)).status).toBe(401);
    expect((await helper.client.take('error')).payload).toEqual({ code: 'session_expired' });
    expect((await helper.client.closed).code).toBe(4001);
    expect(await roomStub(roomId).streamsOf(w.member)).toEqual([]);

    expect(await platformAudit('platform.user.sessions.revoke', w.member)).toEqual([
      expect.objectContaining({ actor_id: admin, data: { count: 2 } }),
    ]);
    expect(await platformAudit('platform.user.devices.revoke', w.member)).toEqual([
      expect.objectContaining({ actor_id: admin, data: { count: 1 } }),
    ]);
    // Not banned: the account still works.
    expect((await call('GET', '/me', w.member)).status).toBe(200);
  });
});

// --- delete ---------------------------------------------------------------------------------

describe('DELETE /api/admin/users/:userId', () => {
  it('refuses while the account owns a space, listing them', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    expect(await call('DELETE', u(w.owner), admin)).toEqual({
      status: 409,
      body: { code: 'owner_must_transfer', userId: w.owner, spaceIds: [w.spaceId] },
    });
    // Once the space is deleted, the owner can go.
    expect((await call('DELETE', `/spaces/${w.spaceId}`, w.owner)).status).toBe(204);
    expect((await call('DELETE', u(w.owner), admin)).status).toBe(204);
  });

  it('deletes every personal row, keeps the audit anonymized, closes the sockets', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    const target = w.member;
    const email = newEmail();
    const roomId = await fixedRoom(w, { visibility: 'restricted' });
    const db = env.DB;
    const now = Date.now();
    await db.batch([
      db
        .prepare('UPDATE users SET primary_email = ?, avatar_url = ?, locale = ? WHERE id = ?')
        .bind(email, 'https://cdn.example/a.png', 'pt-BR', target),
      db
        .prepare(
          `INSERT INTO room_access (room_id, user_id, can_view, can_stream, granted_by, granted_at)
         VALUES (?, ?, 1, 1, ?, ?), (?, ?, 1, 0, ?, ?)`,
        )
        .bind(roomId, target, w.owner, now, roomId, w.guest, target, now),
      db
        .prepare(
          `INSERT INTO user_tutorial (user_id, seen_json, updated_at) VALUES (?, '["spaces"]', ?)`,
        )
        .bind(target, now),
      db
        .prepare(
          `INSERT INTO email_tokens (token_hash, email, purpose, expires_at) VALUES (?, ?, 'login', ?)`,
        )
        .bind(`th_${target}`, email, now + 1000),
      db
        .prepare('INSERT INTO auth_rate_events (bucket, created_at) VALUES (?, ?)')
        .bind(`device_link:${target}`, now),
      db
        .prepare(
          `INSERT INTO realtime_sessions (session_id, space_id, room_id, user_id, device_id, kind, created_at)
         VALUES (?, ?, ?, ?, 'd_x', 'view', ?)`,
        )
        .bind(`rs_${target}`, w.spaceId, roomId, target, now),
    ]);
    await identity(target, 'email', email);
    await identity(target, 'discord', `d-${target}`);
    await session(target);
    const d = await device(target);
    // Audit rows by and about the person.
    expect(
      (await call('PATCH', `/spaces/${w.spaceId}/members/${w.member2}`, w.owner, { role: 'admin' }))
        .status,
    ).toBe(200);
    await call('PATCH', `/spaces/${w.spaceId}/members/${target}`, w.owner, { role: 'admin' });
    await call('PATCH', `/spaces/${w.spaceId}/members/${w.guest}`, target, { role: 'member' });
    const web = await Client.join(roomId, target);
    const tab = await hubTab(target);

    expect((await call('DELETE', u(target), admin)).status).toBe(204);

    expect((await web.client.take('kicked')).payload).toEqual({ reason: 'removed' });
    expect((await web.client.closed).code).toBe(4004);
    expect((await tab.closed).code).toBe(4001);

    // No row with the person's id or address is left, in any table the deletion touches.
    const rows = async (sql: string, ...values: unknown[]) =>
      (
        await db
          .prepare(sql)
          .bind(...values)
          .all()
      ).results;
    expect(
      await rows('SELECT 1 FROM space_members WHERE user_id = ? OR invited_by = ?', target, target),
    ).toEqual([]);
    expect(
      await rows('SELECT 1 FROM room_access WHERE user_id = ? OR granted_by = ?', target, target),
    ).toEqual([]);
    expect(
      await rows('SELECT 1 FROM join_requests WHERE user_id = ? OR decided_by = ?', target, target),
    ).toEqual([]);
    expect(await rows('SELECT 1 FROM invites WHERE created_by = ?', target)).toEqual([]);
    expect(await rows('SELECT 1 FROM rooms WHERE created_by = ?', target)).toEqual([]);
    expect(await rows('SELECT 1 FROM sessions WHERE user_id = ?', target)).toEqual([]);
    expect(await rows('SELECT 1 FROM devices WHERE user_id = ? OR id = ?', target, d.id)).toEqual(
      [],
    );
    expect(await rows('SELECT 1 FROM device_codes WHERE approved_by = ?', target)).toEqual([]);
    expect(await rows('SELECT 1 FROM identities WHERE user_id = ?', target)).toEqual([]);
    expect(await rows('SELECT 1 FROM user_tutorial WHERE user_id = ?', target)).toEqual([]);
    expect(await rows('SELECT 1 FROM email_tokens WHERE email = ?', email)).toEqual([]);
    expect(await rows('SELECT 1 FROM auth_rate_events WHERE bucket LIKE ?', `%${target}%`)).toEqual(
      [],
    );
    expect(await rows('SELECT 1 FROM realtime_sessions WHERE user_id = ?', target)).toEqual([]);
    expect(
      await rows('SELECT user_id FROM realtime_sessions WHERE session_id = ?', `rs_${target}`),
    ).toEqual([{ user_id: 'deleted' }]);
    expect(await rows('SELECT 1 FROM banned_identities WHERE user_id = ?', target)).toEqual([]);
    // The audit keeps what happened, without who: no id, no name, anywhere but the deletion row.
    expect(
      await rows(
        `SELECT action FROM audit_log WHERE (actor_id = ?1 OR target = ?1 OR instr(data_json, ?1) > 0)
         AND action != 'platform.user.delete'`,
        target,
      ),
    ).toEqual([]);
    const roleChanges = await rows(
      `SELECT actor_id, target FROM audit_log WHERE space_id = ? AND action = 'member.role.change'
       ORDER BY created_at, rowid`,
      w.spaceId,
    );
    expect(roleChanges).toEqual([
      { actor_id: w.owner, target: w.member2 },
      { actor_id: w.owner, target: null },
      { actor_id: null, target: w.guest },
    ]);
    expect(await platformAudit('platform.user.delete', target)).toEqual([
      expect.objectContaining({ actor_id: admin, data: { ban: false, messages: 'delete' } }),
    ]);
    // The users row is a tombstone with nothing personal.
    expect(
      await db
        .prepare(
          `SELECT display_name, avatar_url, primary_email, locale, last_seen_at, banned_at,
                  deleted_at IS NOT NULL AS deleted FROM users WHERE id = ?`,
        )
        .bind(target)
        .first(),
    ).toEqual({
      display_name: '',
      avatar_url: null,
      primary_email: null,
      locale: null,
      last_seen_at: null,
      banned_at: null,
      deleted: 1,
    });
    expect(DELETION_TABLES).toContain('audit_log');

    // Gone: not listed, not found, cannot act.
    expect((await call('GET', u(target), admin)).status).toBe(404);
    expect((await call('GET', '/me', target)).status).toBe(401);
    const all = await call('GET', `/admin/users?query=${target}`, admin);
    expect(all.body.users).toEqual([]);
  });

  it('with ban: keeps the identities banned after the account is gone', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const lonely = await newUser('lonely');
    await identity(lonely, 'discord', `d-${lonely}`);
    expect((await call('DELETE', u(lonely), admin, { ban: true })).status).toBe(204);
    const kept = await env.DB.prepare(
      'SELECT provider, user_id FROM banned_identities WHERE identity_hash = ?',
    )
      .bind(await identityHash('discord', `d-${lonely}`))
      .first();
    expect(kept).toEqual({ provider: 'discord', user_id: null });
    expect(await platformAudit('platform.user.delete', lonely)).toEqual([
      expect.objectContaining({ data: { ban: true, messages: 'delete' } }),
    ]);
    expect((await call('DELETE', u(lonely), admin, { ban: 'yes' })).body).toEqual({
      code: 'user_not_found',
      userId: lonely,
    });
  });

  it('also removes a space member who owns nothing', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    await addMember(w.spaceId, await newUser('extra'), 'member');
    expect((await call('DELETE', u(w.guest), admin)).status).toBe(204);
    const members = await call('GET', `/spaces/${w.spaceId}/members`, w.owner);
    expect(members.body.members.map((m: { userId: string }) => m.userId)).not.toContain(w.guest);
  });
});
