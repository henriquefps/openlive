// SPDX-License-Identifier: AGPL-3.0-only
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json';

/** This file has no beforeAll: its first request also starts the Worker, slow under `pnpm test`. */
const COLD_START_MS = 15_000;

describe('GET /api/health', () => {
  it(
    'answers ok with the version and the build (dev outside a deploy)',
    async () => {
      const res = await exports.default.fetch('http://localhost/api/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        version: pkg.version,
        commit: 'dev',
        builtAt: null,
      });
    },
    COLD_START_MS,
  );

  it('returns an error code, never text, for unknown routes', async () => {
    const res = await exports.default.fetch('http://localhost/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'not_found' });
  });
});

describe('Durable Object stubs', () => {
  it.each([
    ['RoomDO', env.ROOM],
    ['UserHubDO', env.USER_HUB],
    ['SpaceDO', env.SPACE],
  ] as const)('%s answers its health request', async (name, ns) => {
    const stub = ns.get(ns.idFromName('health'));
    const res = await stub.fetch('http://do/health');
    expect(await res.json()).toEqual({ ok: true, object: name });
  });
});
