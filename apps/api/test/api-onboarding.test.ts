// SPDX-License-Identifier: AGPL-3.0-only
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REALTIME_API } from '../src/api/checks';
import worker from '../src/index';
import { DEV_USER_HEADER } from '../src/room/identity';
import { call, type Json, migrate, newUser } from './api-helpers';

// The onboarding wizard's checks and progress and the tutorial state.

beforeAll(migrate);
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM platform_settings WHERE key = 'onboarding'").run();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Every secret the checks read, with values that must never show up in a response. */
const SECRETS = {
  DISCORD_CLIENT_ID: 'secret-discord-id',
  DISCORD_CLIENT_SECRET: 'secret-discord-secret',
  RESEND_API_KEY: 'secret-resend-key',
  EMAIL_FROM: 'Openlive <login@example.test>',
  REALTIME_APP_ID: 'secret-app-id',
  REALTIME_APP_TOKEN: 'secret-app-token',
  TURN_KEY_ID: 'secret-turn-id',
  TURN_KEY_TOKEN: 'secret-turn-token',
};

/** GET /api/admin/checks with the given env overrides (worker.fetch, so fetch can be replaced). */
async function checks(userId: string, overrides: Record<string, string | undefined>) {
  const request = new Request('http://localhost/api/admin/checks', {
    headers: { [DEV_USER_HEADER]: userId },
  });
  const res = await worker.fetch(request, { ...env, ...overrides }, createExecutionContext());
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Json };
}

/** Realtime answers: the SFU renegotiate probe 400s on the empty body as the real one does (token accepted), TURN returns credentials. */
function realtime(sfu = 400, turn = 201) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url.startsWith(`${REALTIME_API}/apps/`)) {
      return Response.json({ errorCode: 'decoding_error' }, { status: sfu });
    }
    if (url.startsWith(`${REALTIME_API}/turn/keys/`)) {
      return Response.json(
        {
          iceServers: [{ urls: ['turn:x'], username: 'turn-user', credential: 'turn-credential' }],
        },
        { status: turn },
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  return calls;
}

const byId = (body: Json): Record<string, Json> =>
  Object.fromEntries((body.checks as Json[]).map((check) => [check.id, check]));

describe('GET /api/admin/checks', () => {
  it('is only for the platform admin', async () => {
    const user = await newUser('user');
    expect((await call('GET', '/admin/checks')).status).toBe(401);
    expect((await call('GET', '/admin/checks', user)).status).toBe(403);
  });

  it('reports every item ok when all secrets are set and the services answer', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const calls = realtime();
    const res = await checks(admin, SECRETS);
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual(
      ['discord', 'email', 'sfu', 'turn', 'd1', 'r2'].map((id) => ({
        id,
        status: 'ok',
        code: 'configured',
      })),
    );
    // Read-only probes: a session lookup (not sessions/new) and a 60 s TURN credential.
    const sfu = calls.find((c) => c.url.includes('/apps/'));
    expect(sfu?.url).toMatch(/\/apps\/secret-app-id\/sessions\/[0-9a-f]{32}\/renegotiate$/);
    expect(sfu?.init?.method).toBe('PUT');
    expect(sfu?.init?.body).toBe('{}');
    const turn = calls.find((c) => c.url.includes('/turn/'));
    expect(turn?.url).toBe(
      `${REALTIME_API}/turn/keys/secret-turn-id/credentials/generate-ice-servers`,
    );
    expect(JSON.parse(String(turn?.init?.body))).toEqual({ ttl: 60 });
    for (const value of [...Object.values(SECRETS), 'turn-user', 'turn-credential']) {
      expect(res.text).not.toContain(value);
    }
  });

  const PAIRS: [string, string][] = [
    ['DISCORD_CLIENT_ID', 'discord'],
    ['DISCORD_CLIENT_SECRET', 'discord'],
    ['RESEND_API_KEY', 'email'],
    ['EMAIL_FROM', 'email'],
    ['REALTIME_APP_ID', 'sfu'],
    ['REALTIME_APP_TOKEN', 'sfu'],
    ['TURN_KEY_ID', 'turn'],
    ['TURN_KEY_TOKEN', 'turn'],
  ];

  it.each(PAIRS)('reports %s as missing on the %s item', async (secret, item) => {
    const admin = await newUser('admin', { platformAdmin: true });
    realtime();
    const res = await checks(admin, { ...SECRETS, [secret]: undefined });
    const results = byId(res.body);
    expect(results[item]).toEqual({
      id: item,
      status: 'missing',
      code: 'secret_missing',
      missing: [secret],
    });
    for (const [id, check] of Object.entries(results)) {
      if (id !== item) expect(check.status).toBe('ok');
    }
    for (const value of Object.values(SECRETS)) expect(res.text).not.toContain(value);
  });

  it('treats a blank secret as missing and skips the call', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const calls = realtime();
    const res = await checks(admin, { ...SECRETS, TURN_KEY_TOKEN: '  ' });
    expect(byId(res.body).turn.status).toBe('missing');
    expect(calls.some((c) => c.url.includes('/turn/'))).toBe(false);
  });

  it('reports refused credentials and an unreachable service as errors', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    realtime(401, 503);
    const results = byId((await checks(admin, SECRETS)).body);
    expect(results.sfu).toEqual({ id: 'sfu', status: 'error', code: 'auth_failed' });
    expect(results.turn).toEqual({ id: 'turn', status: 'error', code: 'unreachable' });

    // A wrong app id answers 404 on the probe.
    vi.restoreAllMocks();
    realtime(404);
    const wrongApp = byId((await checks(admin, SECRETS)).body);
    expect(wrongApp.sfu).toEqual({ id: 'sfu', status: 'error', code: 'auth_failed' });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    const offline = byId((await checks(admin, SECRETS)).body);
    expect(offline.sfu.code).toBe('unreachable');
    expect(offline.turn.code).toBe('unreachable');
  });
});

describe('the onboarding wizard progress', () => {
  it('starts at step 1, saves the step, keeps a skip while resuming, and completes once', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    let res = await call('GET', '/admin/onboarding', admin);
    expect(res.body.onboarding).toEqual({ step: 1, completedAt: null, skippedAt: null });

    res = await call('PUT', '/admin/onboarding', admin, { step: 3, state: 'in_progress' });
    expect(res.status).toBe(200);
    expect(res.body.onboarding).toEqual({ step: 3, completedAt: null, skippedAt: null });

    res = await call('PUT', '/admin/onboarding', admin, { step: 3, state: 'skipped' });
    expect(res.body.onboarding.skippedAt).toEqual(expect.any(Number));
    res = await call('GET', '/admin/onboarding', admin);
    expect(res.body.onboarding).toMatchObject({ step: 3, completedAt: null });
    expect(res.body.onboarding.skippedAt).toEqual(expect.any(Number));

    // Resuming moves the step; the skip stays (the /admin reminder) until completion.
    const skippedAt = res.body.onboarding.skippedAt as number;
    res = await call('PUT', '/admin/onboarding', admin, { step: 4, state: 'in_progress' });
    expect(res.body.onboarding).toEqual({ step: 4, completedAt: null, skippedAt });

    res = await call('PUT', '/admin/onboarding', admin, { step: 7, state: 'completed' });
    const completedAt = res.body.onboarding.completedAt as number;
    expect(completedAt).toEqual(expect.any(Number));
    // Completed is final.
    res = await call('PUT', '/admin/onboarding', admin, { step: 2, state: 'skipped' });
    expect(res.body.onboarding).toEqual({ step: 2, completedAt, skippedAt: null });
  });

  it('validates the body and is only for the platform admin', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const user = await newUser('user');
    expect((await call('GET', '/admin/onboarding', user)).status).toBe(403);
    expect(
      (await call('PUT', '/admin/onboarding', user, { step: 1, state: 'skipped' })).status,
    ).toBe(403);
    const bad = await call('PUT', '/admin/onboarding', admin, { step: 8, state: 'skipped' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ code: 'invalid_message', path: '/step' });
  });
});

describe('GET/PUT /api/me/tutorial', () => {
  it('starts empty, stores seen screens and the off switch, and replays', async () => {
    const user = await newUser('user');
    expect((await call('GET', '/me/tutorial')).status).toBe(401);
    let res = await call('GET', '/me/tutorial', user);
    expect(res.body.tutorial).toEqual({ seen: [], disabled: false });

    res = await call('PUT', '/me/tutorial', user, { seen: ['spaces', 'topbar'], disabled: false });
    expect(res.body.tutorial).toEqual({ seen: ['spaces', 'topbar'], disabled: false });
    res = await call('PUT', '/me/tutorial', user, {
      seen: ['spaces', 'topbar', 'spaces'],
      disabled: true,
    });
    expect(res.body.tutorial).toEqual({ seen: ['spaces', 'topbar'], disabled: true });
    expect((await call('GET', '/me/tutorial', user)).body.tutorial.disabled).toBe(true);

    // Replay (Settings → Replay tutorial).
    res = await call('PUT', '/me/tutorial', user, { seen: [], disabled: false });
    expect(res.status).toBe(200);
    expect((await call('GET', '/me/tutorial', user)).body.tutorial).toEqual({
      seen: [],
      disabled: false,
    });

    // Each user has their own.
    const other = await newUser('other');
    expect((await call('GET', '/me/tutorial', other)).body.tutorial.seen).toEqual([]);
  });

  it('rejects screen ids that do not look like ids', async () => {
    const user = await newUser('user');
    const res = await call('PUT', '/me/tutorial', user, { seen: ['Not An Id'], disabled: false });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'invalid_message', path: '/seen/0' });
  });
});
