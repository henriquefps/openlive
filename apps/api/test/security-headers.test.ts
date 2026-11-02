// SPDX-License-Identifier: AGPL-3.0-only
import { env, exports } from 'cloudflare:workers';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import headersText from '../../web/public/_headers?raw';
import {
  API_CSP,
  APP_CSP,
  ASSET_CACHE_CONTROL,
  DOCUMENT_CACHE_CONTROL,
  APP_HEADERS,
  COMMON_HEADERS,
  headersFile,
  HSTS,
  securityHeaders,
} from '../src/security/headers';
import { DEV_USER_HEADER } from '../src/room/identity';
import { migrate, newUser } from './api-helpers';

// Security headers (src/security/headers.ts): the static files
// get theirs from apps/web/public/_headers, every Worker response from the middleware.

beforeAll(async () => {
  await migrate();
});

const fetchApp = (url: string, init?: RequestInit) => exports.default.fetch(url, init);

function expectWorkerHeaders(res: Response, opts: { https?: boolean } = {}) {
  expect(res.headers.get('Content-Security-Policy')).toBe(API_CSP);
  for (const [name, value] of Object.entries(COMMON_HEADERS)) {
    expect([name, res.headers.get(name)]).toEqual([name, value]);
  }
  expect(res.headers.get('Strict-Transport-Security')).toBe(opts.https ? HSTS : null);
}

describe('static files (_headers)', () => {
  it('is exactly what headersFile() renders', () => {
    expect(headersText).toBe(headersFile());
  });

  it('applies the app policy to every path', () => {
    const lines = headersText.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(lines[0]).toBe('/*');
    const parsed = Object.fromEntries(
      lines.slice(1, lines.indexOf('/assets/*')).map((l) => {
        const at = l.indexOf(':');
        return [l.slice(0, at).trim(), l.slice(at + 1).trim()];
      }),
    );
    expect(parsed).toEqual({ ...APP_HEADERS, 'Cache-Control': DOCUMENT_CACHE_CONTROL });
  });

  it('marks every document no-transform (zone script injection) and keeps assets compressible', () => {
    // /* covers / and the SPA fallback (index.html under any route); the zone's injected scripts
    // honour no-transform. The hashed assets detach it: no-transform would turn off compression.
    expect(DOCUMENT_CACHE_CONTROL).toMatch(/\bno-cache\b/);
    expect(DOCUMENT_CACHE_CONTROL).toMatch(/\bno-transform\b/);
    expect(ASSET_CACHE_CONTROL).not.toContain('no-transform');
    expect(headersText.split('\n')).toContain('/assets/*\n'.trim());
    expect(headersText).toMatch(
      /\/assets\/\*\n {2}! Cache-Control\n {2}Cache-Control: public, max-age=31536000, immutable\n$/,
    );
  });

  it('keeps the app policy strict', () => {
    const directives = new Map(
      APP_CSP.split('; ').map((d) => {
        const [name = '', ...values] = d.split(' ');
        return [name, values];
      }),
    );
    // No inline or eval script, no plugin, no framing, no <base> injection.
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'self'"]);
    expect(APP_CSP).not.toContain('unsafe-eval');
    expect(APP_CSP).not.toMatch(/\*|https: |wss: /);
  });
});

describe('Worker responses', () => {
  it('API 200: headers, no-store and no-transform', async () => {
    const res = await fetchApp('http://localhost/api/health');
    expect(res.status).toBe(200);
    expectWorkerHeaders(res);
    expect(res.headers.get('Cache-Control')).toBe('no-store, no-transform');
  });

  it('API 200 for a signed-in caller', async () => {
    const user = await newUser('headers');
    const res = await fetchApp('http://localhost/api/me', { headers: { [DEV_USER_HEADER]: user } });
    expect(res.status).toBe(200);
    expectWorkerHeaders(res);
    expect(res.headers.get('Cache-Control')).toBe('no-store, no-transform');
  });

  it('API 401 and 404', async () => {
    for (const [path, status] of [
      ['/api/me', 401],
      ['/api/nope', 404],
      ['/nothing-here', 404],
    ] as const) {
      const res = await fetchApp(`http://localhost${path}`);
      expect(res.status).toBe(status);
      expectWorkerHeaders(res);
      expect(res.headers.get('Cache-Control')).toBe('no-store, no-transform');
    }
  });

  it('API 403 from the CSRF check', async () => {
    const res = await fetchApp('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expectWorkerHeaders(res);
  });

  it('HTML a route sends gets no-transform, whatever its own Cache-Control', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', securityHeaders);
    app.get('/page', (c) => c.html('<p>x</p>'));
    app.get('/cached', (c) => c.html('<p>x</p>', 200, { 'Cache-Control': 'private, max-age=10' }));
    app.get('/done', (c) => c.html('<p>x</p>', 200, { 'Cache-Control': 'no-cache, No-Transform' }));
    app.get('/json', (c) => c.json({}, 200, { 'Cache-Control': 'private' }));
    const get = async (path: string) =>
      (await app.request(`http://localhost${path}`, {}, env)).headers.get('Cache-Control');
    expect(await get('/page')).toBe('no-store, no-transform');
    expect(await get('/cached')).toBe('private, max-age=10, no-transform');
    expect(await get('/done')).toBe('no-cache, No-Transform');
    expect(await get('/json')).toBe('private');
  });

  it('HSTS on https only', async () => {
    const res = await fetchApp('https://openlive.example/api/health');
    expectWorkerHeaders(res, { https: true });
  });

  it('auth redirects', async () => {
    const res = await fetchApp('https://openlive.example/api/auth/discord/start', {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expectWorkerHeaders(res, { https: true });
    expect(res.headers.get('Cache-Control')).toBe('no-store, no-transform');
  });

  it('refused WebSocket upgrades', async () => {
    for (const path of ['/ws/hub', '/ws/rooms/r_1', '/ws/spaces/sp_1']) {
      const res = await fetchApp(`http://localhost${path}`, { headers: { Upgrade: 'websocket' } });
      expect([path, res.status]).toEqual([path, 401]);
      expectWorkerHeaders(res);
    }
    const foreign = await fetchApp('http://localhost/ws/hub', {
      headers: { Upgrade: 'websocket', Origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    expectWorkerHeaders(foreign);
  });

  it('an accepted WebSocket upgrade is passed through untouched', async () => {
    const user = await newUser('ws');
    const res = await fetchApp('http://localhost/ws/hub', {
      headers: { Upgrade: 'websocket', [DEV_USER_HEADER]: user },
    });
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("keeps a route's own headers, also on a response with immutable headers", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', securityHeaders);
    app.get('/own', (c) => c.body('x', 200, { 'Cache-Control': 'private, max-age=10' }));
    // Like a response passed through from fetch(): its headers cannot be changed.
    app.get('/frozen', () => Response.redirect('https://openlive.example/', 302));
    const own = await app.request('http://localhost/own', {}, env);
    expect(own.headers.get('Cache-Control')).toBe('private, max-age=10');
    expectWorkerHeaders(own);
    const frozen = await app.request('http://localhost/frozen', {}, env);
    expect(frozen.status).toBe(302);
    expectWorkerHeaders(frozen);
  });
});
