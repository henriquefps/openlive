// SPDX-License-Identifier: AGPL-3.0-only
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetViewerRateLimit, VIEWER_POSTS_PER_MINUTE } from '../src/api/metrics';
import worker from '../src/index';
import {
  addHelperSample,
  emptyHelperWindow,
  writeHelper,
  writeStreamEnd,
} from '../src/metrics/points';
import {
  clearStatusCache,
  loadStatus,
  REQUIRED_PERMISSION,
  SQL_ENDPOINT,
  statusQueries,
  summarize,
} from '../src/metrics/status';
import { DEV_USER_HEADER } from '../src/room/identity';
import { fixedRoom, type Json, migrate, newUser, world, type World } from './api-helpers';

// Observability: the viewer metrics endpoint, the Analytics Engine points it and the
// error middleware write (on a mock binding), the helper window, and the status API read back
// through a fake Analytics Engine SQL API.

/** A mock Analytics Engine dataset that keeps what was written. */
function mockDataset() {
  const points: AnalyticsEngineDataPoint[] = [];
  return { points, writeDataPoint: (p?: AnalyticsEngineDataPoint) => void points.push(p ?? {}) };
}

async function request(
  method: string,
  path: string,
  opts: {
    user?: string;
    body?: unknown;
    metrics?: ReturnType<typeof mockDataset>;
    extra?: object;
  } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (opts.user) headers[DEV_USER_HEADER] = opts.user;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://localhost/api${path}`, {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
    { ...env, ...(opts.metrics ? { METRICS: opts.metrics } : {}), ...opts.extra } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const sample = (roomId: string) => ({
  roomId,
  streamId: 'st_metrics',
  windowMs: 30_000,
  watchMs: 29_000,
  ttffMs: 412,
  start: 'prepull',
  layer: 'f',
  freezes: 1,
  fps: 59.64,
  bitrateKbps: 7420.4,
  lossPct: 0.1,
  framesDropped: 2,
  decodeErrors: 0,
  reconnects: 0,
  rttMs: 38.2,
  jitterBufferMs: 14.25,
});

let w: World;
let roomId: string;

beforeAll(async () => {
  await migrate();
  w = await world();
  roomId = await fixedRoom(w);
});
beforeEach(() => {
  resetViewerRateLimit();
  clearStatusCache();
});
afterEach(() => vi.restoreAllMocks());

describe('POST /api/metrics/viewer', () => {
  it('writes one viewer point with ids and numbers only', async () => {
    const metrics = mockDataset();
    const res = await request('POST', '/metrics/viewer', {
      user: w.member,
      body: sample(roomId),
      metrics,
    });
    expect(res.status).toBe(204);
    expect(metrics.points).toEqual([
      {
        indexes: [w.spaceId],
        blobs: ['viewer', w.spaceId, roomId, 'st_metrics', 'f', 'prepull'],
        doubles: [30, 29, 412, 1, 1, 59.64, 7420, 0.1, 2, 0, 0, 38, 14.25],
      },
    ]);
  });

  it('marks a window without a first frame', async () => {
    const metrics = mockDataset();
    const rest: Partial<ReturnType<typeof sample>> = sample(roomId);
    delete rest.ttffMs;
    delete rest.layer;
    expect(
      (await request('POST', '/metrics/viewer', { user: w.member, body: rest, metrics })).status,
    ).toBe(204);
    const point = metrics.points[0];
    expect(point?.blobs?.slice(4)).toEqual(['', 'prepull']);
    expect(point?.doubles?.slice(2, 4)).toEqual([0, 0]);
  });

  it('rejects a bad body with the field path', async () => {
    const metrics = mockDataset();
    const res = await request('POST', '/metrics/viewer', {
      user: w.member,
      body: { ...sample(roomId), lossPct: 140 },
      metrics,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'invalid_message', path: '/lossPct' });
    // The error itself is counted, under no space (the room was never resolved).
    expect(metrics.points.map((p) => p.blobs)).toEqual([
      ['error', '', '', '', 'POST', 'invalid_message'],
    ]);
  });

  it('needs a session and room access', async () => {
    expect((await request('POST', '/metrics/viewer', { body: sample(roomId) })).status).toBe(401);
    const res = await request('POST', '/metrics/viewer', {
      user: w.outsider,
      body: sample(roomId),
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  it('is rate-limited per user', async () => {
    const metrics = mockDataset();
    for (let i = 0; i < VIEWER_POSTS_PER_MINUTE; i += 1) {
      expect(
        (
          await request('POST', '/metrics/viewer', {
            user: w.member2,
            body: sample(roomId),
            metrics,
          })
        ).status,
      ).toBe(204);
    }
    const res = await request('POST', '/metrics/viewer', {
      user: w.member2,
      body: sample(roomId),
      metrics,
    });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(res.body.retryAfterMs).toBeGreaterThan(0);
    // Another user is not affected.
    expect(
      (await request('POST', '/metrics/viewer', { user: w.member, body: sample(roomId), metrics }))
        .status,
    ).toBe(204);
  });

  it('works without the binding (a deploy that removed it)', async () => {
    const res = await request('POST', '/metrics/viewer', {
      user: w.member,
      body: sample(roomId),
      extra: { METRICS: undefined },
    });
    expect(res.status).toBe(204);
  });
});

describe('error counts', () => {
  it('counts an error response under its code and, when known, its space', async () => {
    const metrics = mockDataset();
    const res = await request('PATCH', `/spaces/${w.spaceId}`, {
      user: w.member,
      body: { name: 'Nope' },
      metrics,
    });
    expect(res.status).toBe(403);
    expect(metrics.points).toEqual([
      {
        indexes: [w.spaceId],
        blobs: ['error', w.spaceId, '', '', 'PATCH', 'forbidden'],
        doubles: [403],
      },
    ]);
  });

  it('leaves out the pairing poll, which answers authorization_pending until approved', async () => {
    const metrics = mockDataset();
    const code = await request('POST', '/devices/code', {
      body: { name: 'test', os: 'linux', arch: 'amd64', helperVersion: '0.1.0' },
    });
    expect(code.status).toBe(200);
    const res = await request('POST', '/devices/token', {
      body: { deviceCode: code.body.deviceCode },
      metrics,
    });
    expect(res.body.code).toBe('authorization_pending');
    expect(metrics.points).toEqual([]);
  });

  it('writes nothing for a success', async () => {
    const metrics = mockDataset();
    expect((await request('GET', `/spaces/${w.spaceId}`, { user: w.member, metrics })).status).toBe(
      200,
    );
    expect(metrics.points).toEqual([]);
  });
});

describe('points written by the Durable Objects', () => {
  it('a stream end counts a drop only when the helper vanished', () => {
    const metrics = mockDataset();
    writeStreamEnd(
      metrics,
      { spaceId: 's1', roomId: 'r1', streamId: 'st1' },
      'helper_disconnected',
      90_000,
    );
    writeStreamEnd(
      metrics,
      { spaceId: 's1', roomId: 'r1', streamId: 'st2' },
      'ended_by_streamer',
      -5,
    );
    expect(metrics.points.map((p) => [p.blobs, p.doubles])).toEqual([
      [
        ['stream', 's1', 'r1', 'st1', 'helper_disconnected'],
        [90, 1],
      ],
      [
        ['stream', 's1', 'r1', 'st2', 'ended_by_streamer'],
        [0, 0],
      ],
    ]);
  });

  it('a helper window averages the reports and keeps the largest IDR', () => {
    const metrics = mockDataset();
    const window = emptyHelperWindow(0);
    const base = {
      deviceId: 'd1',
      streamId: 'st1',
      targetBitrateKbps: 8000,
      width: 1920,
      height: 1080,
      packetLossPct: 0,
      rttMs: 40,
      encoder: 'nvh264',
    };
    addHelperSample(window, {
      ...base,
      sentBitrateKbps: 7800,
      fps: 60,
      capturedFps: 60,
      cpuPct: 10,
      keyframeRequests: 1,
      idrBytes: 150_000,
    });
    addHelperSample(window, {
      ...base,
      sentBitrateKbps: 7600,
      fps: 58,
      keyframeRequests: 2,
      idrBytes: 90_000,
      packetLossPct: 1,
    });
    writeHelper(metrics, { spaceId: 's1', roomId: 'r1', streamId: 'st1' }, window, 30_000);
    expect(metrics.points[0]?.blobs).toEqual(['helper', 's1', 'r1', 'st1', 'nvh264']);
    // windowS, samples, capturedFps (one report had it), sentFps, target, sent, cpu, loss, rtt,
    // keyframe requests, largest IDR
    expect(metrics.points[0]?.doubles).toEqual([
      30, 2, 60, 59, 8000, 7700, 10, 0.5, 40, 3, 150_000,
    ]);
  });

  it('an empty helper window writes nothing', () => {
    const metrics = mockDataset();
    writeHelper(metrics, { spaceId: 's1' }, emptyHelperWindow(0), 30_000);
    expect(metrics.points).toEqual([]);
  });
});

describe('status queries', () => {
  it('reads one space, by the documented columns', () => {
    const q = statusQueries('7d', 'sp_1', false);
    expect(q.viewer).toContain(
      "WHERE blob1 = 'viewer' AND timestamp > NOW() - INTERVAL '7' DAY AND index1 = 'sp_1'",
    );
    expect(q.viewer).toContain('sum(_sample_interval * double2) AS watch_s');
    expect(q.ttff).toContain('quantileExactWeighted(0.5)(double3, _sample_interval)');
    expect(q.ttff).toContain('AND double4 = 1');
    expect(q.helper).toContain('max(double11) AS idr_max');
    expect(q.errors).toContain('blob6 AS code');
    expect(q.breaker).toContain("WHERE blob1 = 'breaker'");
    expect(q.breaker).toContain('blob5 AS object, blob7 AS cause');
    expect(q.viewer).toContain("SELECT 'all' AS space");
    expect(statusQueries('24h', null, true).viewer).toContain('SELECT index1 AS space');
  });

  it('refuses an id that could break out of the SQL string', () => {
    expect(() => statusQueries('24h', "x' OR '1'='1", false)).toThrow(RangeError);
  });

  it('summarizes rows, including numbers sent as strings', () => {
    const out = summarize({
      viewer: [{ space: 'all', watch_s: '7200', freezes: 3, reconnects: 1, decode_errors: 0 }],
      ttff: [{ space: 'all', n: 20, p50: 412.4, p90: 690 }],
      ttffByStart: [
        { space: 'all', start: 'prepull', n: 12, p50: 120, p90: 300 },
        { space: 'all', start: 'click', n: 8, p50: 980, p90: 1100 },
      ],
      helper: [
        {
          space: 'all',
          n: 120,
          window_s: 3600,
          sent_fps: 7140,
          captured_fps: 7200,
          captured_n: 120,
          sent_kbps: 900_000,
          cpu: 1200,
          kfr: 30,
          idr_max: 180_000,
        },
      ],
      stream: [{ space: 'all', ended: 4, dropped: 1 }],
      errors: [
        { space: 'all', code: 'slot_not_found', n: 5 },
        { space: 'all', code: 'forbidden', n: 2 },
      ],
      breaker: [{ space: 'all', object: 'RoomDO', cause: 'alarm', n: '1' }],
    }).get('all');
    expect(out).toMatchObject({
      streamsEnded: 4,
      streamsDropped: 1,
      dropRate: 0.25,
      viewerMinutes: 120,
      freezesPerHour: 1.5,
      ttff: {
        count: 20,
        medianMs: 412,
        p90Ms: 690,
        prepull: { medianMs: 120 },
        click: { medianMs: 980 },
      },
      helper: {
        minutes: 60,
        sentFps: 59.5,
        capturedFps: 60,
        sentKbps: 7500,
        cpuPct: 10,
        keyframeRequestsPerHour: 30,
        idrMaxBytes: 180_000,
      },
      topErrors: [
        { code: 'slot_not_found', count: 5 },
        { code: 'forbidden', count: 2 },
      ],
      breakerTrips: [{ object: 'RoomDO', cause: 'alarm', count: 1 }],
    });
  });
});

/** A fake Analytics Engine SQL API: answers each query by what it selects. */
function fakeSql(handler: (sql: string) => Response | Record<string, unknown>[]) {
  const calls: { url: string; auth: string | null; sql: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const sql = String(init?.body ?? '');
    calls.push({ url, auth: new Headers(init?.headers).get('Authorization'), sql });
    const out = handler(sql);
    return out instanceof Response ? out : Response.json({ meta: [], data: out, rows: out.length });
  });
  return calls;
}

const CONFIGURED = { CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_ACCOUNT_ID: 'acc1' };

describe('GET /api/spaces/:spaceId/status', () => {
  it('is for the space owners and admins', async () => {
    fakeSql(() => []);
    expect(
      (await request('GET', `/spaces/${w.spaceId}/status`, { user: w.member, extra: CONFIGURED }))
        .status,
    ).toBe(403);
    expect(
      (await request('GET', `/spaces/${w.spaceId}/status`, { user: w.outsider, extra: CONFIGURED }))
        .status,
    ).toBe(404);
    expect(
      (await request('GET', `/spaces/${w.spaceId}/status`, { user: w.admin, extra: CONFIGURED }))
        .status,
    ).toBe(200);
  });

  it('says what is missing when the instance has no token', async () => {
    const res = await request('GET', `/spaces/${w.spaceId}/status`, { user: w.owner });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      range: '24h',
      available: false,
      reason: 'not_configured',
      missing: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    });
  });

  it('names the permission when the token lacks it', async () => {
    fakeSql(() => new Response('{"errors":[{"message":"Authentication error"}]}', { status: 403 }));
    const res = await request('GET', `/spaces/${w.spaceId}/status?range=7d`, {
      user: w.owner,
      extra: CONFIGURED,
    });
    expect(res.body).toEqual({
      range: '7d',
      available: false,
      reason: 'permission',
      permission: REQUIRED_PERMISSION,
    });
  });

  it('queries only this space and answers the summary', async () => {
    const calls = fakeSql((sql) =>
      sql.includes('AS watch_s')
        ? [{ space: 'all', watch_s: 600, freezes: 0, reconnects: 0, decode_errors: 0 }]
        : [],
    );
    const res = await request('GET', `/spaces/${w.spaceId}/status`, {
      user: w.owner,
      extra: CONFIGURED,
    });
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.summary.viewerMinutes).toBe(10);
    expect(res.body.summary.ttff.medianMs).toBeNull();
    expect(calls.length).toBe(7);
    for (const call of calls) {
      expect(call.url).toBe(SQL_ENDPOINT('acc1'));
      expect(call.auth).toBe('Bearer test-token');
      expect(call.sql).toContain(`index1 = '${w.spaceId}'`);
      expect(call.sql).toMatch(/FORMAT JSON$/);
    }
  });

  it('rejects an unknown range', async () => {
    const res = await request('GET', `/spaces/${w.spaceId}/status?range=1y`, {
      user: w.owner,
      extra: CONFIGURED,
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/status', () => {
  it('is for the platform admin, and lists spaces by name', async () => {
    const admin = await newUser('statusadmin', { platformAdmin: true });
    fakeSql((sql) =>
      sql.includes('AS watch_s')
        ? sql.includes('index1 AS space')
          ? [
              { space: w.spaceId, watch_s: 120, freezes: 0, reconnects: 0, decode_errors: 0 },
              { space: 'sp_gone', watch_s: 60, freezes: 0, reconnects: 0, decode_errors: 0 },
            ]
          : [{ space: 'all', watch_s: 180, freezes: 0, reconnects: 0, decode_errors: 0 }]
        : [],
    );
    expect(
      (await request('GET', '/admin/status', { user: w.owner, extra: CONFIGURED })).status,
    ).toBe(403);
    const res = await request('GET', '/admin/status', { user: admin, extra: CONFIGURED });
    expect(res.status).toBe(200);
    expect(res.body.summary.viewerMinutes).toBe(3);
    expect(res.body.spaces).toEqual([
      expect.objectContaining({
        spaceId: w.spaceId,
        name: expect.any(String),
        summary: expect.objectContaining({ viewerMinutes: 2 }),
      }),
      expect.objectContaining({ spaceId: 'sp_gone', name: null }),
    ]);
  });
});

describe('loadStatus', () => {
  it('caches an answer for a minute, and does not cache a failure', async () => {
    let fail = true;
    const fetchFn = vi.fn(async () =>
      fail ? new Response('boom', { status: 500 }) : Response.json({ data: [] }),
    ) as unknown as typeof fetch;
    const config = { token: 't', accountId: 'a' };
    expect(await loadStatus(config, '24h', 'sp_1', false, 0, fetchFn)).toEqual({
      available: false,
      reason: 'unavailable',
    });
    fail = false;
    expect((await loadStatus(config, '24h', 'sp_1', false, 1_000, fetchFn)).available).toBe(true);
    const calls = vi.mocked(fetchFn).mock.calls.length;
    await loadStatus(config, '24h', 'sp_1', false, 30_000, fetchFn);
    expect(vi.mocked(fetchFn).mock.calls.length).toBe(calls);
    await loadStatus(config, '24h', 'sp_1', false, 62_000, fetchFn);
    expect(vi.mocked(fetchFn).mock.calls.length).toBeGreaterThan(calls);
  });

  it('treats a dataset that does not exist yet as no data', async () => {
    const fetchFn = (async () =>
      new Response('unknown table openlive_metrics', { status: 422 })) as unknown as typeof fetch;
    const result = await loadStatus({ token: 't', accountId: 'a' }, '24h', null, false, 0, fetchFn);
    expect(result.available).toBe(true);
  });
});
