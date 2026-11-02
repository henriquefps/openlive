// SPDX-License-Identifier: AGPL-3.0-only
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, type Json, migrate, newUser } from './api-helpers';
import { Client, newRoom, seed, USERS } from './room-helpers';

// Helper pairing (docs/PROTOCOL.md 11.1): device code, polling, approval on /link,
// the device token on REST and on the room socket, and revocation.

beforeAll(async () => {
  await migrate();
  await seed();
});

const HELPER = { name: 'desk', os: 'linux', arch: 'amd64', helperVersion: '0.1.0' } as const;

/** A call without any credentials, or with a device token. */
async function raw(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await exports.default.fetch(`http://localhost/api${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Runs the whole flow for `userId` and returns the helper's token. */
async function pair(userId: string, name = 'My PC') {
  const code = await raw('POST', '/devices/code', { body: HELPER });
  expect(code.status).toBe(200);
  const approve = await call('POST', '/devices/approve', userId, {
    userCode: code.body.userCode,
    name,
  });
  expect(approve.status).toBe(200);
  const token = await raw('POST', '/devices/token', {
    body: { deviceCode: code.body.deviceCode },
  });
  expect(token.status).toBe(200);
  return token.body as { deviceId: string; userId: string; deviceToken: string };
}

const allowPoll = (deviceCode: string) =>
  env.DB.prepare('UPDATE device_codes SET last_poll_at = NULL')
    .run()
    .then(() => deviceCode);

describe('pairing', () => {
  it('runs code → pending → slow_down → approve → token, once', async () => {
    const user = await newUser('pair');
    const code = await raw('POST', '/devices/code', { body: HELPER });
    expect(code.status).toBe(200);
    expect(code.body).toMatchObject({
      verificationUri: 'http://localhost/link',
      expiresInMs: 600_000,
      intervalMs: 5_000,
    });
    expect(code.body.userCode).toMatch(/^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/);
    expect(code.body.verificationUriComplete).toBe(
      `http://localhost/link?code=${code.body.userCode}`,
    );
    expect(code.body.deviceCode).toHaveLength(43);
    const { deviceCode, userCode } = code.body as { deviceCode: string; userCode: string };

    const poll = () => raw('POST', '/devices/token', { body: { deviceCode } });
    expect(await poll()).toEqual({ status: 400, body: { code: 'authorization_pending' } });
    // Polling again before the interval: slow_down, and the interval grows by 5 s.
    expect(await poll()).toEqual({ status: 400, body: { code: 'slow_down', intervalMs: 10_000 } });

    // The person looks the code up (any case, without the hyphen) and approves it.
    const info = await call(
      'GET',
      `/devices/code/${userCode.replace('-', '').toLowerCase()}`,
      user,
    );
    expect(info).toEqual({
      status: 200,
      body: { ...HELPER, userCode, expiresAt: expect.any(Number) },
    });
    const approve = await call('POST', '/devices/approve', user, {
      userCode: userCode.toLowerCase(),
      name: "Henrique's PC",
    });
    expect(approve).toEqual({ status: 200, body: { userCode } });
    // Approved codes are no longer pending.
    expect((await call('GET', `/devices/code/${userCode}`, user)).status).toBe(404);

    await allowPoll(deviceCode);
    const token = await poll();
    expect(token.status).toBe(200);
    expect(token.body).toEqual({
      deviceId: expect.stringMatching(/^d_/),
      userId: user,
      deviceToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    // Exchanged once: the code is gone.
    expect(await poll()).toEqual({ status: 400, body: { code: 'expired_token' } });

    // Only the token's hash is stored.
    const row = await env.DB.prepare('SELECT * FROM devices WHERE id = ?')
      .bind(token.body.deviceId)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ user_id: user, name: "Henrique's PC", os: 'linux' });
    expect(JSON.stringify(row)).not.toContain(token.body.deviceToken);
  });

  it('expires codes', async () => {
    const user = await newUser('expire');
    const code = await raw('POST', '/devices/code', { body: HELPER });
    await env.DB.prepare('UPDATE device_codes SET expires_at = 1 WHERE user_code = ?')
      .bind(code.body.userCode.replace('-', ''))
      .run();
    expect(
      await raw('POST', '/devices/token', { body: { deviceCode: code.body.deviceCode } }),
    ).toEqual({ status: 400, body: { code: 'expired_token' } });
    expect(
      await call('POST', '/devices/approve', user, { userCode: code.body.userCode, name: 'PC' }),
    ).toEqual({ status: 404, body: { code: 'device_code_invalid' } });
  });

  it('refuses unknown codes, bad bodies and anonymous approvals', async () => {
    const user = await newUser('bad');
    expect(
      await call('POST', '/devices/approve', user, { userCode: 'ZZZ-ZZZ', name: 'PC' }),
    ).toEqual({ status: 404, body: { code: 'device_code_invalid' } });
    expect(await call('GET', '/devices/code/O0O-I1L', user)).toEqual({
      status: 404,
      body: { code: 'device_code_invalid' },
    });
    expect((await raw('POST', '/devices/code', { body: { ...HELPER, os: 'beos' } })).body).toEqual({
      code: 'invalid_message',
      path: '/os',
    });
    expect(
      (await raw('POST', '/devices/approve', { body: { userCode: 'ZZZ-ZZZ', name: 'PC' } })).status,
    ).toBe(401);
    expect(await raw('POST', '/devices/token', { body: { deviceCode: 'x'.repeat(43) } })).toEqual({
      status: 400,
      body: { code: 'expired_token' },
    });
  });

  it('rate-limits code lookups per person', async () => {
    const user = await newUser('guess');
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await call('GET', '/devices/code/ZZZ-ZZZ', user)).status;
    expect(last).toBe(429);
  });
});

describe('device identity', () => {
  it('authenticates REST calls with the device token and refreshes lastSeenAt', async () => {
    const user = await newUser('rest');
    const { deviceId, deviceToken } = await pair(user);
    // A route the helper calls: past authentication, the room just does not exist.
    const room = await raw('GET', '/rooms/r_missing', { token: deviceToken });
    expect(room.status).toBe(404);
    expect(room.body.code).toBe('room_not_found');
    const list = await call('GET', '/me/devices', user);
    expect(list.body.devices).toEqual([
      {
        deviceId,
        name: 'My PC',
        os: 'linux',
        arch: 'amd64',
        helperVersion: '0.1.0',
        createdAt: expect.any(Number),
        lastSeenAt: expect.any(Number),
      },
    ]);
    // A wrong bearer is not retried as anything else.
    expect((await raw('GET', '/rooms/r_missing', { token: 'nope' })).status).toBe(401);
  });

  it('refuses the device token on every route the helper does not need', async () => {
    const user = await newUser('scope', { platformAdmin: true });
    const { deviceToken } = await pair(user);
    const refused: [string, string, unknown?][] = [
      ['GET', '/me'],
      ['PUT', '/me', { displayName: 'stolen' }],
      ['GET', '/me/sessions'],
      ['DELETE', '/me/avatar'],
      ['GET', '/avatars/u_1/abc'],
      ['DELETE', '/me/sessions/s_1'],
      ['GET', '/spaces'],
      ['POST', '/spaces', { name: 'Stolen', slug: 'stolen' }],
      ['POST', '/spaces/sp_1/invites', {}],
      ['POST', '/invites/x/accept'],
      ['GET', '/admin/overview'],
      ['GET', '/admin/users'],
      ['PUT', '/admin/settings', {}],
      ['GET', '/helper/latest'],
      ['GET', '/streams/st_1/thumbnail'],
      ['POST', '/rtc/leave', { roomId: 'r_1', sessionId: 's_1' }],
    ];
    for (const [method, path, body] of refused) {
      const res = await raw(method, path, { token: deviceToken, body });
      expect([method, path, res.status, res.body?.code]).toEqual([method, path, 403, 'forbidden']);
    }
    // The helper's own routes still authenticate it (the room does not exist).
    for (const path of ['/rooms/r_missing', '/rtc/rooms/r_missing/ice']) {
      const method = path.endsWith('/ice') ? 'POST' : 'GET';
      expect((await raw(method, path, { token: deviceToken })).status).toBe(404);
    }
  });

  it('keeps device management away from device tokens', async () => {
    const user = await newUser('mgmt');
    const { deviceId, deviceToken } = await pair(user);
    expect((await raw('GET', '/me/devices', { token: deviceToken })).status).toBe(403);
    expect((await raw('DELETE', `/me/devices/${deviceId}`, { token: deviceToken })).status).toBe(
      403,
    );
    expect(
      (
        await raw('POST', '/devices/approve', {
          token: deviceToken,
          body: { userCode: 'ZZZ-ZZZ', name: 'x' },
        })
      ).status,
    ).toBe(403);
  });

  it('revokes: the token stops working, someone else cannot revoke it', async () => {
    const user = await newUser('rev');
    const other = await newUser('other');
    const { deviceId, deviceToken } = await pair(user);
    expect(await call('DELETE', `/me/devices/${deviceId}`, other)).toEqual({
      status: 404,
      body: { code: 'device_not_found', deviceId },
    });
    expect((await call('DELETE', `/me/devices/${deviceId}`, user)).status).toBe(204);
    expect((await raw('GET', '/me', { token: deviceToken })).status).toBe(401);
    expect((await call('GET', '/me/devices', user)).body.devices).toEqual([]);
    expect((await call('DELETE', `/me/devices/${deviceId}`, user)).status).toBe(404);
  });
});

describe('device identity on the room socket', () => {
  async function openWithToken(roomId: string, token: string) {
    const res = await exports.default.fetch(`http://localhost/ws/rooms/${roomId}`, {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(101);
    return Client.adopt(res);
  }
  const hello = (deviceId: string, client: 'helper' | 'web' = 'helper') => ({
    protocol: { major: 1, minor: 1 },
    client,
    clientVersion: '0.1.0',
    ...(client === 'helper' ? { deviceId } : { tabId: 'tab1' }),
  });

  it('accepts the helper whose hello names its device, closes it with 4001 on revoke', async () => {
    const roomId = await newRoom();
    const { deviceId, deviceToken } = await pair(USERS.member1.id);
    const helper = await openWithToken(roomId, deviceToken);
    expect((await helper.request('hello', hello(deviceId))).type).toBe('welcome');

    expect((await call('DELETE', `/me/devices/${deviceId}`, USERS.member1.id)).status).toBe(204);
    expect((await helper.take('error')).payload).toEqual({ code: 'session_expired' });
    expect((await helper.closed).code).toBe(4001);
  });

  it('refuses a hello naming another device, or a device token saying web', async () => {
    const roomId = await newRoom();
    const { deviceToken } = await pair(USERS.member1.id);
    for (const h of [hello('d_other'), hello('', 'web')]) {
      const c = await openWithToken(roomId, deviceToken);
      const reply = await c.request('hello', h);
      expect(reply).toMatchObject({ type: 'error', payload: { code: 'unauthenticated' } });
      expect((await c.closed).code).toBe(4001);
    }
  });

  it('refuses a helper hello from a browser session', async () => {
    const roomId = await newRoom();
    const c = await Client.open(roomId, USERS.member1.id);
    const reply = await c.request('hello', hello('d_pc'));
    expect(reply).toMatchObject({ type: 'error', payload: { code: 'unauthenticated' } });
    expect((await c.closed).code).toBe(4001);
  });
});
