// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, migrate, newUser } from './api-helpers';
import {
  detectWorkersPlan,
  figureFromAnswer,
  limitQuery,
  loadLimits,
  logsFigure,
  METRIC_SOURCES,
  nextUtcMidnight,
  overageUsd,
  resetLimitsCache,
  SUBSCRIPTIONS_ENDPOINT,
} from '../src/usage/cloudflare-limits';
import { LIMIT_METRICS, logSamplingOf, PAID_MONTHLY_INCLUDED } from '../src/usage/free-tier';
import { GRAPHQL_ENDPOINT } from '../src/usage/realtime-usage';

// The admin's Cloudflare limits panel against mocked Cloudflare APIs: never a real
// account. Figures degrade one by one, the plan comes from the subscriptions or the admin.

beforeAll(migrate);
beforeEach(resetLimitsCache);
afterEach(() => {
  vi.restoreAllMocks();
});

const config = { token: 'test-token', accountId: 'acc' };
const NOW = Date.UTC(2026, 9, 28, 12);

/**
 * Answers shaped like Cloudflare's (developers.cloudflare.com/analytics/graphql-api/errors/: every
 * answer has `errors`, null when there are none; a refused query is a 4xx or a 200 with errors).
 */
const answer = (groups: { sum?: Record<string, unknown> | null }[]) => ({
  data: { viewer: { accounts: [{ groups }] } },
  errors: null,
});
const refused = (message: string, dataset = 'durableObjectsPeriodicGroups') => ({
  data: null,
  errors: [
    {
      message,
      path: ['viewer', 'accounts', '0', dataset],
      extensions: { timestamp: '2026-10-29T00:14:03.512893117Z' },
    },
  ],
});

/** A fake Cloudflare API: GraphQL sums by field (null: refused) and the subscriptions list. */
function fakeCloudflare(
  sums: Partial<Record<string, number | null>>,
  subscriptions: unknown[] | number = [],
) {
  const requests: { url: string; body: string }[] = [];
  const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    requests.push({ url: String(url), body });
    if (String(url) === SUBSCRIPTIONS_ENDPOINT('acc')) {
      if (typeof subscriptions === 'number') return new Response('no', { status: subscriptions });
      return Response.json({ success: true, result: subscriptions });
    }
    expect(String(url)).toBe(GRAPHQL_ENDPOINT);
    const { query } = JSON.parse(body) as { query: string };
    const metric = LIMIT_METRICS.find((m) => {
      const s = METRIC_SOURCES[m];
      return query.includes(`${s.dataset}(`) && query.includes(`sum { ${s.field} }`);
    });
    const value = metric ? sums[metric] : undefined;
    if (value === null || value === undefined || !metric) {
      const field = metric ? METRIC_SOURCES[metric].field : '?';
      return Response.json(refused(`unknown field "${field}"`), { status: 400 });
    }
    const field = METRIC_SOURCES[metric].field;
    // Two groups, to check they are summed.
    return Response.json(answer([{ sum: { [field]: value - 1 } }, { sum: { [field]: 1 } }]));
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

const graphqlOf = (requests: { url: string; body: string }[]) =>
  requests
    .filter((r) => r.url === GRAPHQL_ENDPOINT)
    .map((r) => JSON.parse(r.body) as { query: string; variables: Record<string, string> });

describe('Cloudflare limits', () => {
  it('builds one query per figure from the documented datasets', () => {
    expect(limitQuery('d1AnalyticsAdaptiveGroups', 'rowsWritten')).toContain(
      'd1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $since })',
    );
    // The last 24 hours: a Time range, as the Workers tutorial filters workersInvocationsAdaptive.
    const rolling = limitQuery('workersInvocationsAdaptive', 'requests', 'datetime');
    expect(rolling).toContain('$since: Time!, $until: Time!');
    expect(rolling).toContain('filter: { datetime_geq: $since, datetime_leq: $until }');
    expect(new Set(Object.values(METRIC_SOURCES).map((s) => s.dataset))).toEqual(
      new Set([
        'durableObjectsPeriodicGroups',
        'durableObjectsInvocationsAdaptiveGroups',
        'd1AnalyticsAdaptiveGroups',
        'workersInvocationsAdaptive',
      ]),
    );
    expect(nextUtcMidnight(NOW)).toBe(Date.UTC(2026, 9, 29));
  });

  it('says what is missing without a token, and keeps the admin plan', async () => {
    const report = await loadLimits({ token: undefined, accountId: 'acc' }, 'paid', NOW);
    expect(report.plan).toEqual({
      setting: 'paid',
      detected: null,
      detection: { reason: 'not_configured', missing: ['CLOUDFLARE_API_TOKEN'] },
      effective: 'paid',
    });
    expect(report.today.doRowsWritten).toEqual({
      used: null,
      reason: 'not_configured',
      missing: ['CLOUDFLARE_API_TOKEN'],
    });
  });

  it('on Free: today against the daily caps, a refused figure not available', async () => {
    const { fetchFn, requests } = fakeCloudflare({
      doRowsWritten: 72_000,
      doRowsRead: 10_000,
      doRequests: 4_000,
      doDuration: null,
      d1RowsWritten: 300,
      d1RowsRead: 1_200,
      workerRequests: 900,
    });
    const report = await loadLimits(config, 'detect', NOW, fetchFn);
    expect(report.plan).toMatchObject({ detected: 'free', effective: 'free', detection: null });
    expect(report.today.doRowsWritten).toEqual({ used: 72_000 });
    expect(report.last24h.doRowsWritten).toEqual({ used: 72_000 });
    // Refused: Cloudflare's own message, never a zero.
    expect(report.today.doDuration).toEqual({
      used: null,
      reason: 'not_exposed',
      detail: 'unknown field "duration"',
    });
    expect(report.month).toBeNull();
    expect(report.resetsAt).toBe(Date.UTC(2026, 9, 29));
    // Today since 00:00 UTC and the 24 hours before now; the token only in the header.
    const graphql = graphqlOf(requests);
    expect(graphql).toHaveLength(2 * LIMIT_METRICS.length);
    const today = graphql.filter((q) => q.variables.until === undefined);
    expect(today).toHaveLength(LIMIT_METRICS.length);
    expect(today.every((q) => q.variables.since === '2026-10-28')).toBe(true);
    const rolling = graphql.filter((q) => q.variables.until !== undefined);
    expect(rolling.every((q) => q.variables.until === '2026-10-28T12:00:00.000Z')).toBe(true);
    expect(rolling.filter((q) => q.query.includes('datetime_geq'))).toHaveLength(5);
    expect(rolling.filter((q) => q.query.includes('datetimeHour_geq'))).toHaveLength(2);
    expect(requests.every((r) => !r.body.includes('test-token'))).toBe(true);
    // The raw answers, for the panel's disclosure.
    expect(report.debug).toHaveLength(2 * LIMIT_METRICS.length);
    expect(
      report.debug.find((d) => d.metric === 'doDuration' && d.window === 'today'),
    ).toMatchObject({ status: 400, variables: { since: '2026-10-28' } });
    // Cached for five minutes: the panel does not spend requests itself.
    await loadLimits(config, 'detect', NOW + 60_000, fetchFn);
    expect(requests).toHaveLength(2 * LIMIT_METRICS.length + 1);
  });

  it('on Paid: the month so far against the included amounts, with the overage', async () => {
    const { fetchFn, requests } = fakeCloudflare(
      { doRowsWritten: 60_000_000, doRequests: 500_000, workerRequests: 12_000_000 },
      [{ state: 'Paid', rate_plan: { id: 'workers_paid', public_name: 'Workers Paid' } }],
    );
    const report = await loadLimits(config, 'detect', NOW, fetchFn);
    expect(report.plan).toMatchObject({ detected: 'paid', effective: 'paid' });
    expect(report.month?.start).toBe('2026-10-01');
    expect(report.month?.figures.doRowsWritten).toEqual({ used: 60_000_000 });
    // 10 million rows written beyond 50 million at $1.00, 2 million requests beyond 10 at $0.30.
    expect(report.month?.overageUsd).toBeCloseTo(10 + 0.6, 6);
    expect(graphqlOf(requests).some((q) => q.variables.since === '2026-10-01')).toBe(true);
    const figures = report.month?.figures;
    if (!figures) throw new Error('no month');
    expect(overageUsd({ ...figures, doRowsRead: { used: 0 } })).toBeCloseTo(10.6, 6);
    expect(PAID_MONTHLY_INCLUDED.doRowsWritten).toBe(50_000_000);
  });

  it('estimates Workers Logs events from the invocations and the sampling rate', async () => {
    const { fetchFn } = fakeCloudflare({ doRequests: 140_000, workerRequests: 13_000 });
    const report = await loadLimits({ ...config, logSampling: 0.1 }, 'free', NOW, fetchFn);
    // (13,000 Worker + 140,000 Durable Object invocations) x 0.1, against 200,000 a day.
    expect(report.logs).toMatchObject({
      sampling: 0.1,
      today: { used: 15_300 },
      last24h: { used: 15_300 },
      month: null,
      freeDaily: 200_000,
      paidMonthly: 20_000_000,
    });
    // Unknown when an invocation figure is, with that figure's reason.
    expect(
      logsFigure({ ...report.today, doRequests: { used: null, reason: 'failed' } }, 1),
    ).toEqual({ used: null, reason: 'failed' });
    expect(report.logs.today).toEqual({ used: 15_300 });
    // Without a token: not configured, like the figures it comes from.
    const bare = await loadLimits({ token: undefined, accountId: 'acc' }, 'free', NOW);
    expect(bare.logs.today).toMatchObject({ used: null, reason: 'not_configured' });
  });

  it('on Paid: log events beyond 20 million a month are billed at $0.60 a million', async () => {
    const { fetchFn } = fakeCloudflare({ doRequests: 25_000_000, workerRequests: 5_000_000 }, [
      { state: 'Paid', rate_plan: { id: 'workers_paid', public_name: 'Workers Paid' } },
    ]);
    const report = await loadLimits({ ...config, logSampling: 1 }, 'detect', NOW, fetchFn);
    expect(report.logs.month).toEqual({ used: 30_000_000 });
    // 24 million DO requests over the included 1 million at $0.15, 10 million log events at $0.60.
    expect(report.month?.overageUsd).toBeCloseTo(24 * 0.15 + 10 * 0.6, 6);
    expect(logSamplingOf('0.25')).toBe(0.25);
    expect(logSamplingOf(undefined)).toBe(1);
    expect(logSamplingOf('2')).toBe(1);
    expect(logSamplingOf('x')).toBe(1);
  });

  it('detects the plan from the subscriptions, or says which permission it needs', async () => {
    const plan = (subs: unknown[] | number) =>
      detectWorkersPlan('t', 'acc', fakeCloudflare({}, subs).fetchFn);
    expect(await plan([])).toEqual({ plan: 'free' });
    expect(
      await plan([{ state: 'Paid', rate_plan: { id: 'pro', public_name: 'Pro Plan' } }]),
    ).toEqual({ plan: 'free' });
    expect(
      await plan([
        { state: 'Cancelled', rate_plan: { id: 'workers_paid', public_name: 'Workers Paid' } },
      ]),
    ).toEqual({ plan: 'free' });
    expect(await plan([{ state: 'Paid', rate_plan: { public_name: 'Workers Bundled' } }])).toEqual({
      plan: 'paid',
    });
    expect(await plan(403)).toEqual({ reason: 'permission', permission: 'Billing Read' });
    expect(await plan(500)).toEqual({ reason: 'failed', detail: 'HTTP 500' });
  });

  it('a token without Account Analytics: Read leaves the figures not available', async () => {
    // 403 with Cloudflare's message (errors docs: "not authorized for that account").
    const fetchFn = vi.fn(async () =>
      Response.json(refused('not authorized for that account', 'workersInvocationsAdaptive'), {
        status: 403,
      }),
    );
    const report = await loadLimits(config, 'free', NOW, fetchFn as unknown as typeof fetch);
    expect(report.today.workerRequests).toEqual({
      used: null,
      reason: 'permission',
      permission: 'Account Analytics: Read',
      detail: 'not authorized for that account',
    });
    expect(report.plan).toMatchObject({
      setting: 'free',
      effective: 'free',
      detection: { reason: 'permission', permission: 'Billing Read' },
    });
  });

  it('reads Cloudflare answers as they come, never inventing a zero', () => {
    // A group per account and window, as recorded in Cloudflare's docs examples.
    expect(figureFromAnswer(answer([{ sum: { requests: 1234 } }]), 'requests')).toEqual({
      used: 1234,
    });
    // No rows yet (just after 00:00 UTC, or analytics lagging): 0, said to be empty.
    expect(figureFromAnswer(answer([]), 'rowsWritten')).toEqual({ used: 0, empty: true });
    // A group without the field, or a null sum: not exposed, not 0.
    expect(figureFromAnswer(answer([{ sum: {} }]), 'rowsWritten')).toEqual({
      used: null,
      reason: 'not_exposed',
      detail: 'sum.rowsWritten is missing from the answer',
    });
    expect(figureFromAnswer(answer([{ sum: { rowsWritten: null } }]), 'rowsWritten')).toMatchObject(
      { used: null, reason: 'not_exposed' },
    );
    // No account in the answer (a wrong account id): failed, with the hint.
    expect(
      figureFromAnswer({ data: { viewer: { accounts: [] } }, errors: null }, 'requests'),
    ).toMatchObject({
      used: null,
      reason: 'failed',
      detail: expect.stringContaining('ACCOUNT_ID'),
    });
    // The errors page's messages: a time range the dataset refuses, the rate limit, parsing.
    expect(
      figureFromAnswer(refused('cannot request data older than 2678400s'), 'requests', 400),
    ).toEqual({ used: null, reason: 'failed', detail: 'cannot request data older than 2678400s' });
    expect(
      figureFromAnswer(
        refused('rate limiter budget depleted, try again after 5 minutes'),
        'requests',
        429,
      ),
    ).toMatchObject({ reason: 'failed', detail: expect.stringContaining('rate limiter') });
    expect(figureFromAnswer(refused('error parsing args'), 'requests', 400)).toMatchObject({
      reason: 'not_exposed',
    });
    expect(figureFromAnswer(refused('Unauthorized'), 'requests', 401)).toMatchObject({
      reason: 'permission',
      detail: 'Unauthorized',
    });
    // A 5xx without a GraphQL body.
    expect(figureFromAnswer({}, 'requests', 503)).toEqual({
      used: null,
      reason: 'failed',
      detail: 'HTTP 503',
    });
  });

  it('an empty answer stays 0 with a note, a non-JSON answer says what came back', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === SUBSCRIPTIONS_ENDPOINT('acc')) return Response.json({ result: [] });
      return new Response('<html>Bad gateway</html>', { status: 502 });
    });
    const report = await loadLimits(config, 'free', NOW, fetchFn as unknown as typeof fetch);
    expect(report.today.workerRequests).toEqual({
      used: null,
      reason: 'failed',
      detail: 'HTTP 502: <html>Bad gateway</html>',
    });
    expect(report.debug[0]).toMatchObject({ status: 502, response: '<html>Bad gateway</html>' });
  });
});

describe('GET /api/admin/limits and PUT /api/admin/workers-plan', () => {
  it('are the platform admin only, and the plan setting sticks', async () => {
    const admin = await newUser('limits_admin', { platformAdmin: true });
    const other = await newUser('limits_other');
    expect((await call('GET', '/admin/limits', other)).status).toBe(403);
    expect((await call('PUT', '/admin/workers-plan', other, { plan: 'paid' })).status).toBe(403);
    // No token in tests: every figure says what is missing.
    const before = await call('GET', '/admin/limits', admin);
    expect(before.status).toBe(200);
    expect(before.body.plan).toMatchObject({ setting: 'detect', effective: null });
    expect(before.body.today.doRowsWritten).toMatchObject({ used: null, reason: 'not_configured' });
    expect(await call('PUT', '/admin/workers-plan', admin, { plan: 'paid' })).toEqual({
      status: 200,
      body: { plan: 'paid' },
    });
    expect((await call('PUT', '/admin/workers-plan', admin, { plan: 'gold' })).status).toBe(400);
    const after = await call('GET', '/admin/limits', admin);
    expect(after.body.plan).toMatchObject({ setting: 'paid', effective: 'paid' });
  });
});
