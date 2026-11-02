// SPDX-License-Identifier: AGPL-3.0-only
import {
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { GRAPHQL_ENDPOINT } from '../src/usage/realtime-usage';
import { runUsageCron } from '../src/usage/scheduled';
import twoDays from './fixtures/realtime-usage.json';

const configured = {
  ...env,
  CLOUDFLARE_API_TOKEN: 'test-token',
  CLOUDFLARE_ACCOUNT_ID: 'acct-1',
  REALTIME_APP_ID: 'app-openlive-dev',
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runScheduled(e: Env, scheduledTime: number) {
  const ctx = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ scheduledTime, cron: '*/15 * * * *' }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

describe('scheduled handler', () => {
  it('is inert without configuration: no fetch, no error, one line a day', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const usageLines = () =>
      log.mock.calls.filter(([line]) => String(line).startsWith('usage cron:')).map(([l]) => l);
    // The test bindings set a Realtime app for the SFU proxy tests; this run has none.
    const unconfigured = { ...env, REALTIME_APP_ID: undefined };
    await runScheduled(unconfigured, Date.parse('2026-10-27T15:00:00Z'));
    expect(fetchSpy).not.toHaveBeenCalled();
    // Each line is a Workers Logs event: only the day's first run says it.
    expect(usageLines()).toEqual([]);
    await runScheduled(unconfigured, Date.parse('2026-10-28T00:00:00Z'));
    expect(usageLines()).toEqual([
      'usage cron: skipped, not configured (missing CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, REALTIME_APP_ID)',
    ]);
  });

  it('fetches yesterday and today and stores real usage', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json(twoDays));
    await runScheduled(configured, Date.parse('2026-10-27T15:00:00Z'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(GRAPHQL_ENDPOINT);
    expect(JSON.parse(init?.body as string).variables).toMatchObject({
      account: 'acct-1',
      appIds: ['app-openlive-dev'],
      start: '2026-10-26T00:00:00.000Z',
      end: '2026-10-27T15:00:00.000Z',
    });

    const { results } = await env.DB.prepare(
      'SELECT day, service, resource_id, egress_bytes FROM usage_real_daily ORDER BY day, service',
    ).all();
    expect(results).toEqual([
      { day: '2026-10-26', service: 'sfu', resource_id: 'app-openlive-dev', egress_bytes: 12.5e9 },
      { day: '2026-10-26', service: 'turn', resource_id: 'turn-key-1', egress_bytes: 6e8 },
      { day: '2026-10-27', service: 'sfu', resource_id: 'app-openlive-dev', egress_bytes: 3.4e9 },
    ]);
  });

  it('reports missing pieces and filters TURN by the instance key', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runUsageCron({ ...configured, CLOUDFLARE_ACCOUNT_ID: '' }, new Date())).toEqual({
      status: 'skipped',
      missing: ['CLOUDFLARE_ACCOUNT_ID'],
    });
    expect(log).not.toHaveBeenCalled();

    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(twoDays));
    const result = await runUsageCron(
      { ...configured, TURN_KEY_ID: 'turn-key-1' },
      new Date('2026-10-01T00:10:00Z'),
      fetchFn,
    );
    expect(result).toEqual({ status: 'stored', rows: 3, totalEgressBytes: 16.5e9 });
    const body = JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string);
    expect(body.variables).toMatchObject({
      turnKeyIds: ['turn-key-1'],
      start: '2026-09-30T00:00:00.000Z',
    });
  });

  it('propagates fetch failures so the cron run shows as failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('nope', { status: 500 }),
    );
    await expect(runScheduled(configured, Date.now())).rejects.toThrow(/HTTP 500/);
  });
});
