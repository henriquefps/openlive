// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  cfCall,
  type CfClient,
  type FetchFn,
  findZones,
  r2State,
  verifyAnalyticsToken,
  verifyDiscordApp,
  verifyResendKey,
  workerDomains,
  workersSubdomain,
} from '../src/api.ts';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fake fetch answering by URL substring, in order; records the calls. */
function fake(routes: [string, number, unknown][]): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...routes];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const i = queue.findIndex(([part]) => url.includes(part));
    if (i === -1) throw new Error(`unexpected ${url}`);
    const [route] = queue.splice(i, 1);
    if (!route) throw new Error(`unexpected ${url}`);
    const [, status, body] = route;
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch: fetchFn, calls };
}

const noSleep = async () => {};
const client = (f: FetchFn): CfClient => ({ fetch: f, token: 'tok-SECRET', sleep: noSleep });
const ok = (result: unknown) => ({ success: true, result, errors: [] });
const err = (code: number, message: string) => ({ success: false, errors: [{ code, message }] });

describe('cfCall', () => {
  it('retries a transient 500, then succeeds', async () => {
    const f = fake([
      ['/zones', 500, err(10000, 'Internal')],
      ['/zones', 500, {}],
      ['/zones', 200, ok([])],
    ]);
    const r = await cfCall(client(f.fetch), '/zones');
    expect(r.success).toBe(true);
    expect(f.calls).toHaveLength(3);
  });

  it('gives up after three 500s and reports the status', async () => {
    const f = fake([
      ['/x', 500, {}],
      ['/x', 500, {}],
      ['/x', 502, {}],
    ]);
    expect(await cfCall(client(f.fetch), '/x')).toMatchObject({ success: false, status: 502 });
  });
});

describe('Cloudflare lookups', () => {
  it('findZones asks for each candidate name within the account', async () => {
    const f = fake([
      ['name=live.example.com', 200, ok([])],
      ['name=example.com', 200, ok([{ id: 'z', name: 'example.com', status: 'active', extra: 1 }])],
    ]);
    const zones = await findZones(client(f.fetch), 'acc', ['live.example.com', 'example.com']);
    expect(zones).toEqual([{ id: 'z', name: 'example.com', status: 'active' }]);
    expect(f.calls[0]?.url).toContain('account.id=acc');
  });

  it('workersSubdomain: set, or not chosen yet', async () => {
    let f = fake([['/workers/subdomain', 200, ok({ subdomain: 'acme' })]]);
    expect(await workersSubdomain(client(f.fetch), 'acc')).toBe('acme');
    f = fake([['/workers/subdomain', 404, err(10007, 'This subdomain does not exist')]]);
    expect(await workersSubdomain(client(f.fetch), 'acc')).toBeNull();
  });

  it('r2State: enabled, or the "enable R2" error', async () => {
    let f = fake([['/r2/buckets', 200, ok({ buckets: [] })]]);
    expect(await r2State(client(f.fetch), 'acc')).toBe('enabled');
    f = fake([
      ['/r2/buckets', 403, err(10042, 'Please enable R2 through the Cloudflare Dashboard.')],
    ]);
    expect(await r2State(client(f.fetch), 'acc')).toBe('not_enabled');
  });

  it('workerDomains: the custom domains of that Worker only', async () => {
    const f = fake([
      [
        '/workers/domains',
        200,
        ok([
          { hostname: 'live.example.com', service: 'openlive' },
          { hostname: 'other.example.com', service: 'other' },
        ]),
      ],
    ]);
    expect(await workerDomains(client(f.fetch), 'acc', 'openlive')).toEqual(['live.example.com']);
  });

  it('never puts the token in a URL', async () => {
    const f = fake([['/zones', 200, ok([])]]);
    await findZones(client(f.fetch), 'acc', ['example.com']);
    expect(f.calls.every((c) => !c.url.includes('SECRET'))).toBe(true);
  });
});

describe('verifyAnalyticsToken', () => {
  const now = new Date('2026-10-27T12:00:00Z');

  it('valid: active token and a 1-row GraphQL answer', async () => {
    const f = fake([
      ['/user/tokens/verify', 200, ok({ status: 'active' })],
      ['/graphql', 200, { data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [] }] } } }],
    ]);
    const v = await verifyAnalyticsToken(f.fetch, 'tok', 'acc', now, noSleep);
    expect(v.status).toBe('valid');
    const body = JSON.parse(String(f.calls[1]?.init?.body)) as {
      query: string;
      variables: unknown;
    };
    expect(body.query).toContain('limit: 1');
    expect(body.variables).toEqual({
      a: 'acc',
      s: '2026-10-26T12:00:00.000Z',
      e: '2026-10-27T12:00:00.000Z',
    });
  });

  it('an account-owned token verifies on the account', async () => {
    const f = fake([
      ['/user/tokens/verify', 401, err(1000, 'Invalid API Token')],
      ['/accounts/acc/tokens/verify', 200, ok({ status: 'active' })],
      ['/graphql', 200, { data: { viewer: { accounts: [{}] } } }],
    ]);
    expect((await verifyAnalyticsToken(f.fetch, 'tok', 'acc', now, noSleep)).status).toBe('valid');
  });

  it('invalid: refused, disabled, or without Account Analytics', async () => {
    let f = fake([
      ['/user/tokens/verify', 401, err(1000, 'Invalid API Token')],
      ['/accounts/acc/tokens/verify', 401, err(1000, 'Invalid API Token')],
    ]);
    expect((await verifyAnalyticsToken(f.fetch, 't', 'acc', now, noSleep)).status).toBe('invalid');
    f = fake([['/user/tokens/verify', 200, ok({ status: 'disabled' })]]);
    expect((await verifyAnalyticsToken(f.fetch, 't', 'acc', now, noSleep)).detail).toMatch(
      /disabled/,
    );
    f = fake([
      ['/user/tokens/verify', 200, ok({ status: 'active' })],
      ['/graphql', 200, { data: null, errors: [{ message: 'not authorized for that account' }] }],
    ]);
    const v = await verifyAnalyticsToken(f.fetch, 't', 'acc', now, noSleep);
    expect(v).toMatchObject({
      status: 'invalid',
      detail: expect.stringMatching(/Account Analytics → Read/),
    });
  });

  it('unknown when the network fails', async () => {
    const failing: FetchFn = async () => {
      throw new Error('ENOTFOUND');
    };
    expect((await verifyAnalyticsToken(failing, 't', 'acc', now, noSleep)).status).toBe('unknown');
  });
});

describe('verifyResendKey', () => {
  it('a send-only key is valid (restricted_api_key), nothing is sent', async () => {
    const f = fake([['/domains', 401, { name: 'restricted_api_key', message: 'restricted' }]]);
    const v = await verifyResendKey(f.fetch, 're_x', 'live.example.com');
    expect(v.status).toBe('valid');
    expect(v.detail).toMatch(/send-only/);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.init?.method ?? 'GET').toBe('GET');
  });

  it('a full-access key also checks the sender domain', async () => {
    const f = fake([['/domains', 200, { data: [{ name: 'example.com', status: 'pending' }] }]]);
    const v = await verifyResendKey(f.fetch, 're_x', 'live.example.com');
    expect(v.status).toBe('valid');
    expect(v.warnings.join()).toMatch(/example\.com is pending/);
    const g = fake([['/domains', 200, { data: [] }]]);
    expect((await verifyResendKey(g.fetch, 're_x', 'live.example.com')).warnings.join()).toMatch(
      /not a domain in this Resend account/,
    );
  });

  it('a bad key is invalid; a 5xx is unknown', async () => {
    let f = fake([['/domains', 403, { name: 'invalid_api_key', message: 'API key is invalid' }]]);
    expect((await verifyResendKey(f.fetch, 're_bad', null)).status).toBe('invalid');
    f = fake([['/domains', 503, {}]]);
    expect((await verifyResendKey(f.fetch, 're_x', null)).status).toBe('unknown');
  });
});

describe('verifyDiscordApp', () => {
  it('valid with a client-credentials token; invalid_client otherwise', async () => {
    let f = fake([['/oauth2/token', 200, { access_token: 'x', token_type: 'Bearer' }]]);
    expect((await verifyDiscordApp(f.fetch, 'id', 'secret')).status).toBe('valid');
    const auth = (f.calls[0]?.init?.headers as Record<string, string>)['Authorization'];
    expect(auth).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
    f = fake([['/oauth2/token', 401, { error: 'invalid_client' }]]);
    expect((await verifyDiscordApp(f.fetch, 'id', 'bad')).status).toBe('invalid');
    f = fake([['/oauth2/token', 429, {}]]);
    expect((await verifyDiscordApp(f.fetch, 'id', 'secret')).status).toBe('unknown');
  });
});
