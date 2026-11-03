// SPDX-License-Identifier: AGPL-3.0-only
import { PROTOCOL_VERSION } from '@openlive/protocol';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { pkceChallenge } from '../src/auth/crypto';
import { call, type Json, newUser, setAccess } from './api-helpers';
import { Client, newRoom, SPACE_ID, seed, USERS } from './room-helpers';

// The mobile app's login and credentials (docs/PROTOCOL.md 11.6): the instance
// description, /app/authorize with PKCE, the app token on REST and on the sockets (tickets),
// revocation, and that an app token is its user, with the same can() answers, minus the platform
// admin's powers.

beforeAll(async () => {
  await seed();
  await setAccess({ signup: 'open', spaceCreation: 'members' });
});

const CLIENT = 'openlive-mobile';
const REDIRECT = 'openlive://auth';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

/** A call with an optional bearer and extra headers, without the development identity. */
async function raw(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Json; headers: Headers }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await exports.default.fetch(`http://localhost${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function authorizeBody(overrides: Record<string, unknown> = {}) {
  return {
    client: CLIENT,
    redirectUri: REDIRECT,
    codeChallenge: await pkceChallenge(VERIFIER),
    codeChallengeMethod: 'S256',
    state: 'st-123',
    deviceName: 'Pixel 9',
    ...overrides,
  };
}

/** The person allows the app (signed in on the web): the code from the redirect. */
async function authorize(userId: string, overrides: Record<string, unknown> = {}) {
  const res = await call('POST', '/app/authorize', userId, await authorizeBody(overrides));
  expect(res.status).toBe(200);
  const url = new URL(res.body.redirectTo);
  expect(`${url.protocol}//${url.host}`).toBe(REDIRECT);
  return { code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state') };
}

const exchange = (code: string, overrides: Record<string, unknown> = {}) =>
  raw('POST', '/api/app/token', {
    body: { code, codeVerifier: VERIFIER, client: CLIENT, redirectUri: REDIRECT, ...overrides },
  });

/** The whole login for `userId`: the app token and its id. */
async function login(userId: string, deviceName = 'Pixel 9') {
  const { code } = await authorize(userId, { deviceName });
  const res = await exchange(code);
  expect(res.status).toBe(200);
  return res.body as { token: string; tokenId: string; user: Json };
}

async function ticket(token: string): Promise<string> {
  const res = await raw('POST', '/api/app/ws-ticket', { token });
  expect(res.status).toBe(200);
  return res.body.ticket;
}

const upgrade = (path: string, headers: Record<string, string> = {}) =>
  exports.default.fetch(`http://localhost${path}`, {
    headers: { Upgrade: 'websocket', ...headers },
  });

const hello = { protocol: PROTOCOL_VERSION, client: 'web', clientVersion: '0.1.0' } as const;

describe('GET /.well-known/openlive.json', () => {
  it('describes the instance: public, cacheable, no personal data', async () => {
    const res = await raw('GET', '/.well-known/openlive.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(res.body).toEqual({
      name: 'localhost',
      iconUrl: 'http://localhost/icon-512.png',
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      commit: expect.any(String),
      protocol: { min: { major: 1, minor: 0 }, max: PROTOCOL_VERSION },
      features: [
        'app_login',
        'ws_ticket',
        'invite_deep_link',
        'capability:stream',
        'capability:voice',
        'capability:camera',
        'capability:text',
      ],
    });
  });

  it('lists only the capabilities the platform allows', async () => {
    await env.DB.prepare(
      `INSERT INTO platform_settings (key, value_json, updated_at) VALUES ('capabilities', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    )
      .bind(JSON.stringify({ stream: true, voice: false, camera: false, text: true }), Date.now())
      .run();
    try {
      const res = await raw('GET', '/.well-known/openlive.json');
      expect(res.body.features).toEqual([
        'app_login',
        'ws_ticket',
        'invite_deep_link',
        'capability:stream',
        'capability:text',
      ]);
    } finally {
      await env.DB.prepare("DELETE FROM platform_settings WHERE key = 'capabilities'").run();
    }
  });
});

describe('PKCE login', () => {
  it('allows the app, then exchanges the code once for an app token', async () => {
    const user = await newUser('app');
    const { code, state } = await authorize(user);
    expect(state).toBe('st-123');
    const res = await exchange(code);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(res.body).toEqual({
      token: expect.stringMatching(/^ola_[A-Za-z0-9_-]{43}$/),
      tokenId: expect.stringMatching(/^at_/),
      user: { userId: user, displayName: 'Name app' },
    });
    // Stored hashed only.
    const row = await env.DB.prepare('SELECT token_hash FROM app_tokens WHERE id = ?')
      .bind(res.body.tokenId)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(res.body.token.slice(4));

    const me = await raw('GET', '/api/me', { token: res.body.token });
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user);

    // Single use.
    expect(await exchange(code)).toMatchObject({ status: 400, body: { code: 'app_code_invalid' } });
  });

  it('refuses a wrong verifier, and the code is gone after it', async () => {
    const { code } = await authorize(await newUser('app'));
    const wrong = await exchange(code, { codeVerifier: 'x'.repeat(43) });
    expect(wrong).toMatchObject({ status: 400, body: { code: 'app_code_invalid' } });
    expect((await exchange(code)).status).toBe(400);
  });

  it('refuses an expired code', async () => {
    const { code } = await authorize(await newUser('app'));
    await env.DB.prepare('UPDATE app_codes SET expires_at = ?')
      .bind(Date.now() - 1)
      .run();
    expect(await exchange(code)).toMatchObject({ status: 400, body: { code: 'app_code_invalid' } });
  });

  it('binds the code to its client and redirect URI', async () => {
    const user = await newUser('app');
    for (const overrides of [{ redirectUri: 'openlive://other' }, { client: 'someone-else' }]) {
      const { code } = await authorize(user);
      expect(await exchange(code, overrides)).toMatchObject({
        status: 400,
        body: { code: 'app_code_invalid' },
      });
    }
    expect(await exchange('not-a-code')).toMatchObject({ status: 400 });
  });

  it('never issues a code for another redirect, client or method, or without state', async () => {
    const user = await newUser('app');
    const cases: [Record<string, unknown>, string][] = [
      [{ redirectUri: 'https://evil.example/cb' }, '/redirectUri'],
      [{ redirectUri: 'openlive://auth.evil.example' }, '/redirectUri'],
      [{ redirectUri: 'openlive://auth/x' }, '/redirectUri'],
      [{ client: 'other-app' }, '/client'],
      [{ codeChallengeMethod: 'plain' }, '/codeChallengeMethod'],
      [{ codeChallenge: 'short' }, '/codeChallenge'],
      [{ state: undefined }, '/state'],
      [{ state: '' }, '/state'],
      [{ state: 'x'.repeat(129) }, '/state'],
      [{ deviceName: '' }, '/deviceName'],
    ];
    for (const [overrides, path] of cases) {
      const res = await call('POST', '/app/authorize', user, await authorizeBody(overrides));
      expect(res, JSON.stringify(overrides)).toEqual({
        status: 400,
        body: { code: 'invalid_message', path },
      });
    }
    const codes = await env.DB.prepare('SELECT count(*) AS n FROM app_codes WHERE user_id = ?')
      .bind(user)
      .first<{ n: number }>();
    expect(codes?.n).toBe(0);
  });

  it('needs a signed-in browser: not anonymous, not an app, not a helper', async () => {
    const user = await newUser('app');
    const { token } = await login(user);
    const body = await authorizeBody();
    expect((await raw('POST', '/api/app/authorize', { body })).status).toBe(401);
    expect((await raw('POST', '/api/app/authorize', { body, token })).status).toBe(403);
    const helper = await exports.default.fetch('http://localhost/api/app/authorize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Openlive-Dev-User': user,
        'X-Openlive-Dev-Device': 'd_pc',
      },
      body: JSON.stringify(body),
    });
    expect(helper.status).toBe(403);
  });

  it('does not issue a token to a user banned since they allowed it', async () => {
    const user = await newUser('app');
    const { code } = await authorize(user);
    await env.DB.prepare('UPDATE users SET banned_at = ? WHERE id = ?')
      .bind(Date.now(), user)
      .run();
    expect((await exchange(code)).status).toBe(400);
  });

  it('rate-limits code exchanges per IP', async () => {
    const headers = { 'CF-Connecting-IP': '203.0.113.77' };
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await raw('POST', '/api/app/token', {
        headers,
        body: { code: 'x', codeVerifier: VERIFIER, client: CLIENT, redirectUri: REDIRECT },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe('app token on the REST API', () => {
  it('gets the same can() answers as a browser session', async () => {
    const { token } = await login(USERS.member1.id);
    const { token: outsider } = await login(USERS.outsider.id);
    for (const path of [`/api/spaces/${SPACE_ID}`, `/api/spaces/${SPACE_ID}/members`]) {
      const byApp = await raw('GET', path, { token });
      const byWeb = await call('GET', path.slice(4), USERS.member1.id);
      expect(byApp.status).toBe(byWeb.status);
      expect(byApp.body).toEqual(byWeb.body);
      const outApp = await raw('GET', path, { token: outsider });
      const outWeb = await call('GET', path.slice(4), USERS.outsider.id);
      expect([outApp.status, outApp.body]).toEqual([outWeb.status, outWeb.body]);
    }
    // A member may not change the space's settings, from the app or the web.
    const put = { name: 'Renamed' };
    const byApp = await raw('PATCH', `/api/spaces/${SPACE_ID}`, { token, body: put });
    const byWeb = await call('PATCH', `/spaces/${SPACE_ID}`, USERS.member1.id, put);
    expect(byApp.status).toBe(byWeb.status);
  });

  it('never carries the platform admin powers', async () => {
    const admin = await newUser('padmin', { platformAdmin: true });
    expect((await call('GET', '/admin/settings', admin)).status).toBe(200);
    const { token } = await login(admin);
    expect(await raw('GET', '/api/admin/settings', { token })).toMatchObject({ status: 403 });
    expect((await raw('GET', '/api/me', { token })).body.user.isPlatformAdmin).toBe(false);
  });

  it('skips the Origin check only for an app bearer without a cookie', async () => {
    const { token } = await login(await newUser('app'));
    const foreign = { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' };
    const ok = await raw('PUT', '/api/me', { token, headers: foreign, body: { displayName: 'A' } });
    expect(ok.status).toBe(200);
    const withCookie = await raw('PUT', '/api/me', {
      token,
      headers: { ...foreign, Cookie: 'ol_session=x' },
      body: { displayName: 'B' },
    });
    expect(withCookie).toMatchObject({ status: 403, body: { code: 'origin_not_allowed' } });
    // A device token gets no such pass.
    const device = await raw('PUT', '/api/me', {
      token: 'A'.repeat(43),
      headers: foreign,
      body: { displayName: 'C' },
    });
    expect(device).toMatchObject({ status: 403, body: { code: 'origin_not_allowed' } });
  });

  it('is listed in Settings > Sessions and revoked from there', async () => {
    const user = await newUser('app');
    const { token, tokenId } = await login(user, "Ana's iPhone");
    const list = await raw('GET', '/api/me/sessions', { token });
    expect(list.body.sessions).toEqual([
      {
        id: tokenId,
        kind: 'app',
        createdAt: expect.any(Number),
        deviceName: "Ana's iPhone",
        lastUsedAt: expect.any(Number),
        current: true,
      },
    ]);
    const other = await newUser('other');
    expect((await call('DELETE', `/me/sessions/${tokenId}`, other)).status).toBe(404);
    expect((await call('DELETE', `/me/sessions/${tokenId}`, user)).status).toBe(204);
    expect((await raw('GET', '/api/me', { token })).status).toBe(401);
    expect((await call('GET', '/me/sessions', user)).body.sessions).toEqual([]);
  });

  it('signs out with DELETE /api/app/token, which only an app token may call', async () => {
    const user = await newUser('app');
    const { token } = await login(user);
    expect((await call('DELETE', '/app/token', user)).status).toBe(403);
    expect((await raw('DELETE', '/api/app/token', { token })).status).toBe(204);
    expect((await raw('GET', '/api/me', { token })).status).toBe(401);
  });

  it('stops working after 90 days unused', async () => {
    const { token, tokenId } = await login(await newUser('app'));
    await env.DB.prepare('UPDATE app_tokens SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, tokenId)
      .run();
    expect((await raw('GET', '/api/me', { token })).status).toBe(401);
  });
});

describe('app sockets', () => {
  it('opens the hub, a space and a room with single-use tickets', async () => {
    const { token } = await login(USERS.member1.id);
    const roomId = await newRoom();
    const hubTicket = await ticket(token);
    const hub = await upgrade(`/ws/hub?ticket=${hubTicket}`);
    expect(hub.status).toBe(101);
    const hubClient = Client.adopt(hub);
    expect((await hubClient.request('hello', { ...hello, tabId: 't_app' })).type).toBe(
      'hub.welcome',
    );
    // Used once.
    expect((await upgrade(`/ws/hub?ticket=${hubTicket}`)).status).toBe(401);

    const space = Client.adopt(
      await upgrade(`/ws/spaces/${SPACE_ID}?ticket=${await ticket(token)}`),
    );
    expect((await space.request('hello', hello)).type).toBe('space.presence');
    const room = Client.adopt(await upgrade(`/ws/rooms/${roomId}?ticket=${await ticket(token)}`));
    expect((await room.request('hello', hello)).type).toBe('welcome');
    for (const c of [hubClient, space, room]) c.close();
  });

  it('refuses a wrong or expired ticket, and does not fall back to the cookie', async () => {
    const { token } = await login(USERS.member1.id);
    const t = await ticket(token);
    await env.DB.prepare('UPDATE app_ws_tickets SET expires_at = ?')
      .bind(Date.now() - 1)
      .run();
    expect((await upgrade(`/ws/hub?ticket=${t}`)).status).toBe(401);
    const fake = `olt_${'A'.repeat(43)}`;
    const res = await upgrade(`/ws/hub?ticket=${fake}`, {
      'X-Openlive-Dev-User': USERS.member1.id,
    });
    expect(res.status).toBe(401);
  });

  it('applies can() to the room as for the web', async () => {
    const { token } = await login(USERS.outsider.id);
    const roomId = await newRoom();
    const res = await upgrade(`/ws/rooms/${roomId}?ticket=${await ticket(token)}`);
    expect(res.status).toBe(403);
  });

  it('gives tickets to app tokens only, at most 20 unused at a time', async () => {
    const user = await newUser('app');
    expect((await call('POST', '/app/ws-ticket', user)).status).toBe(403);
    const { token } = await login(user);
    for (let i = 0; i < 20; i++) await ticket(token);
    const res = await raw('POST', '/api/app/ws-ticket', { token });
    expect(res).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
  });

  it('closes every socket of a revoked app token with 4001', async () => {
    const { token, tokenId } = await login(USERS.member2.id);
    const roomId = await newRoom();
    const hub = Client.adopt(await upgrade(`/ws/hub?ticket=${await ticket(token)}`));
    expect((await hub.request('hello', { ...hello, tabId: 't_app' })).type).toBe('hub.welcome');
    const space = Client.adopt(
      await upgrade(`/ws/spaces/${SPACE_ID}?ticket=${await ticket(token)}`),
    );
    expect((await space.request('hello', hello)).type).toBe('space.presence');
    const room = Client.adopt(await upgrade(`/ws/rooms/${roomId}?ticket=${await ticket(token)}`));
    expect((await room.request('hello', hello)).type).toBe('welcome');
    // The same user's browser stays.
    const web = await Client.open(roomId, USERS.member2.id);
    expect((await web.request('hello', hello)).type).toBe('welcome');

    expect((await call('DELETE', `/me/sessions/${tokenId}`, USERS.member2.id)).status).toBe(204);
    for (const c of [hub, space, room]) {
      expect((await c.take('error')).payload).toEqual({ code: 'session_expired' });
      expect((await c.closed).code).toBe(4001);
    }
    expect((await upgrade(`/ws/hub?ticket=${'olt_' + 'B'.repeat(43)}`)).status).toBe(401);
    const ack = await web.request('queue.leave', { streamId: 'st_x' });
    expect(ack.type).toBe('ack');
    web.close();
  });

  it('accepts the app token as a bearer on the upgrade too', async () => {
    const { token } = await login(USERS.member1.id);
    const res = await upgrade('/ws/hub', { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(101);
    Client.adopt(res).close();
  });
});
