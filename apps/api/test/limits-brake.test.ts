// SPDX-License-Identifier: AGPL-3.0-only
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEmailSenderForTests } from '../src/auth/email';
import type { RoomDO } from '../src/do/room';
import { DEV_USER_HEADER } from '../src/room/identity';
import { METRIC_SOURCES, resetLimitsCache } from '../src/usage/cloudflare-limits';
import {
  FREE_TIER_DAILY,
  LIMIT_METRICS,
  type LimitMetric,
  PAID_MONTHLY_INCLUDED,
} from '../src/usage/free-tier';
import {
  alertLevels,
  alertToSend,
  BRAKE_STATE_KEY,
  brakeTrigger,
  DEFAULT_BRAKE_SETTING,
  engagedByHand,
  forgetBrakeState,
  type LimitsSnapshot,
  nextBrakeState,
  nextMonthStart,
  NO_BRAKE,
  readBrakeRows,
  releasedState,
  sharesOf,
  todayOverageUsd,
} from '../src/usage/limits-brake';
import { runLimitsMonitor } from '../src/usage/limits-monitor';
import { GRAPHQL_ENDPOINT } from '../src/usage/realtime-usage';
import { onQuarterHour } from '../src/usage/scheduled';
import { FakeSender } from './auth-helpers';
import { Client, newRoom, roomStub, seed, SPACE_ID, upgrade, USERS } from './room-helpers';

// The limits monitor and brake against a fake Cloudflare API: never a real account.

const NOW = Date.UTC(2026, 10, 7, 12, 0);
const MIDNIGHT = Date.UTC(2026, 10, 8);

beforeAll(async () => {
  await seed();
  // A platform admin with an address, for the alert e-mails.
  await env.DB.prepare(
    `UPDATE users SET is_platform_admin = 1, primary_email = 'admin@example.com', locale = 'en'
     WHERE id = ?`,
  )
    .bind(USERS.owner.id)
    .run();
});

let sender: FakeSender;
beforeEach(async () => {
  resetLimitsCache();
  sender = new FakeSender();
  setEmailSenderForTests(sender);
  await env.DB.prepare(
    "DELETE FROM platform_settings WHERE key LIKE 'limits_%' OR key = 'workers_plan'",
  ).run();
  forgetBrakeState();
});
afterEach(() => {
  vi.restoreAllMocks();
  setEmailSenderForTests(null);
  forgetBrakeState();
});

type Sums = Partial<Record<LimitMetric, number>>;

/** Cloudflare's GraphQL API answering `today` and `month` sums per metric (date_geq: $since). */
function fakeAnalytics(today: Sums, month: Sums = today) {
  const queries: string[] = [];
  const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe(GRAPHQL_ENDPOINT);
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { since: string };
    };
    queries.push(query);
    const metric = LIMIT_METRICS.find((m) => {
      const s = METRIC_SOURCES[m];
      return query.includes(`${s.dataset}(`) && query.includes(`sum { ${s.field} }`);
    });
    if (!metric) throw new Error('unexpected query');
    // The month's query starts on the 1st (the tests' days are never the 1st).
    const value = (variables.since.endsWith('-01') ? month : today)[metric] ?? 0;
    const field = METRIC_SOURCES[metric].field;
    return Response.json({
      data: { viewer: { accounts: [{ groups: [{ sum: { [field]: value } }] }] } },
      errors: null,
    });
  }) as unknown as typeof fetch;
  return { fetchFn, queries };
}

const configured = {
  ...env,
  CLOUDFLARE_API_TOKEN: 'test-token',
  CLOUDFLARE_ACCOUNT_ID: 'acc',
  APP_ORIGIN: 'https://openlive.example',
};

async function setPlan(plan: 'free' | 'paid') {
  await env.DB.prepare(
    `INSERT INTO platform_settings (key, value_json, updated_at) VALUES ('workers_plan', ?, 0)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
  )
    .bind(JSON.stringify({ plan }))
    .run();
}

const share = (m: LimitMetric, s: number): Sums => ({ [m]: Math.round(FREE_TIER_DAILY[m] * s) });

function snapshotOf(today: Sums, month: Sums | null, plan: 'free' | 'paid' | null): LimitsSnapshot {
  const figures = (sums: Sums) =>
    Object.fromEntries(LIMIT_METRICS.map((m) => [m, { used: sums[m] ?? 0 }])) as Record<
      LimitMetric,
      { used: number }
    >;
  const t = figures(today);
  const mo = month ? figures(month) : null;
  return {
    fetchedAt: NOW,
    day: '2026-11-07',
    plan,
    today: t,
    month: mo
      ? { start: '2026-11-01', figures: mo, overageUsd: 0, todayUsd: todayOverageUsd(mo, t) }
      : null,
    shares: sharesOf(plan, t, mo),
  };
}

describe('the brake arithmetic', () => {
  it('engages on Free at the percent for any metric, until 00:00 UTC', () => {
    for (const m of LIMIT_METRICS) {
      expect(
        brakeTrigger(snapshotOf(share(m, 0.79), null, 'free'), DEFAULT_BRAKE_SETTING, NOW),
      ).toBeNull();
      expect(
        brakeTrigger(snapshotOf(share(m, 0.8), null, 'free'), DEFAULT_BRAKE_SETTING, NOW),
      ).toEqual({ metric: m, share: 0.8, window: 'day', until: MIDNIGHT });
    }
    // An unknown plan is compared as Free, the safe side.
    expect(
      brakeTrigger(snapshotOf(share('doRequests', 0.9), null, null), DEFAULT_BRAKE_SETTING, NOW)
        ?.metric,
    ).toBe('doRequests');
    // Off: never.
    expect(
      brakeTrigger(
        snapshotOf(share('doRequests', 1.2), null, 'free'),
        { ...DEFAULT_BRAKE_SETTING, enabled: false },
        NOW,
      ),
    ).toBeNull();
  });

  it('on Paid uses the month against the included amounts, or the USD a day', () => {
    const monthShare = { doRowsWritten: PAID_MONTHLY_INCLUDED.doRowsWritten * 0.85 };
    const paid = snapshotOf({ doRowsWritten: 5_000_000 }, monthShare, 'paid');
    expect(brakeTrigger(paid, DEFAULT_BRAKE_SETTING, NOW)).toEqual({
      metric: 'doRowsWritten',
      share: 0.85,
      window: 'month',
      until: nextMonthStart(NOW),
    });
    expect(nextMonthStart(NOW)).toBe(Date.UTC(2026, 11, 1));
    // Today's 5 million rows on top of a month already 10 million past the included 50 million:
    // all 5 million are beyond it, $1.00 a million.
    const over = snapshotOf({ doRowsWritten: 5_000_000 }, { doRowsWritten: 60_000_000 }, 'paid');
    expect(over.month?.todayUsd).toBeCloseTo(5);
    // Only the part of today beyond the included amount counts: 52 M - 5 M today = 47 M before.
    const partly = snapshotOf({ doRowsWritten: 5_000_000 }, { doRowsWritten: 52_000_000 }, 'paid');
    expect(partly.month?.todayUsd).toBeCloseTo(2);
    const capped = { ...DEFAULT_BRAKE_SETTING, paid: { includedShare: false, usdPerDay: 4 } };
    expect(brakeTrigger(over, capped, NOW)).toEqual({
      metric: 'paidUsdPerDay',
      share: 1.25,
      window: 'day',
      until: MIDNIGHT,
    });
    expect(brakeTrigger(partly, capped, NOW)).toBeNull();
    // Below the included share and no cap: nothing.
    const below = snapshotOf({ doRowsWritten: 5_000_000 }, { doRowsWritten: 30_000_000 }, 'paid');
    expect(below.month?.todayUsd).toBe(0);
    expect(brakeTrigger(below, DEFAULT_BRAKE_SETTING, NOW)).toBeNull();
  });

  it('lapses at its release time, and a release by hand holds until 00:00 UTC', () => {
    const trigger = {
      metric: 'doRequests' as const,
      share: 0.8,
      window: 'day' as const,
      until: MIDNIGHT,
    };
    const on = nextBrakeState(NO_BRAKE, trigger, NOW);
    expect(on.engagedNow).toBe(true);
    expect(on.state.engaged).toMatchObject({ since: NOW, by: 'monitor', until: MIDNIGHT });
    // Still above the next run: engaged, not again.
    expect(nextBrakeState(on.state, trigger, NOW + 300_000)).toEqual({
      state: on.state,
      engagedNow: false,
    });
    // Past 00:00 UTC with the new day's low figures: released.
    expect(nextBrakeState(on.state, null, MIDNIGHT).state).toEqual(NO_BRAKE);
    // Released by hand: the monitor does not engage it again today.
    const released = releasedState(NOW);
    expect(released).toEqual({ engaged: null, releasedUntil: MIDNIGHT });
    expect(nextBrakeState(released, trigger, NOW + 300_000).engagedNow).toBe(false);
    expect(
      nextBrakeState(released, { ...trigger, until: MIDNIGHT + 86_400_000 }, MIDNIGHT).engagedNow,
    ).toBe(true);
    expect(engagedByHand(NOW).engaged).toMatchObject({
      by: 'admin',
      until: MIDNIGHT,
      metric: null,
    });
  });

  it('e-mails each level once a day, one e-mail for levels reached together', () => {
    const levels = alertLevels(DEFAULT_BRAKE_SETTING);
    expect(levels).toEqual([50, 70, 80]);
    expect(alertLevels({ ...DEFAULT_BRAKE_SETTING, enabled: false })).toEqual([50, 70, 90]);
    expect(alertLevels({ ...DEFAULT_BRAKE_SETTING, percent: 50 })).toEqual([50, 70]);
    const none = { day: '', sent: [] };
    expect(alertToSend(0.49, levels, none, '2026-11-07')).toBeNull();
    const first = alertToSend(0.75, levels, none, '2026-11-07');
    expect(first).toEqual({ level: 70, sent: { day: '2026-11-07', sent: [50, 70] } });
    const sent = first?.sent ?? none;
    expect(alertToSend(0.78, levels, sent, '2026-11-07')).toBeNull();
    expect(alertToSend(0.81, levels, sent, '2026-11-07')?.level).toBe(80);
    // A new day starts over.
    expect(alertToSend(0.55, levels, sent, '2026-11-08')?.level).toBe(50);
  });
});

describe('the monitor', () => {
  it('stores the snapshot, and a second run on the same figures changes nothing', async () => {
    const { fetchFn, queries } = fakeAnalytics({ doRequests: 10_000 });
    const first = await runLimitsMonitor(configured, NOW, fetchFn);
    expect(first.status).toBe('stored');
    // Workers Free (chosen or detected): today's 7 figures only.
    await setPlan('free');
    queries.length = 0;
    const again = await runLimitsMonitor(configured, NOW + 300_000, fetchFn);
    expect(queries).toHaveLength(LIMIT_METRICS.length);
    const rows = await readBrakeRows(env.DB);
    expect(rows.snapshot).toMatchObject({
      fetchedAt: NOW + 300_000,
      day: '2026-11-07',
      plan: 'free',
      shares: { doRequests: 0.1 },
    });
    expect(again).toMatchObject({ status: 'stored', engagedNow: false, alerted: null });
    expect(rows.state).toEqual(NO_BRAKE);
    expect(sender.sent).toEqual([]);
  });

  it('alerts once per level per day', async () => {
    await setPlan('free');
    const at = async (s: number, now: number) =>
      runLimitsMonitor(configured, now, fakeAnalytics(share('d1RowsRead', s)).fetchFn);
    expect((await at(0.55, NOW)).status).toBe('stored');
    expect(sender.sent.map((m) => m.subject)).toEqual([
      'Openlive: Cloudflare limits at 50% (D1 rows read)',
    ]);
    expect(sender.sent[0]?.to).toBe('admin@example.com');
    expect(sender.sent[0]?.text).toContain('https://openlive.example/admin');
    await at(0.6, NOW + 300_000);
    await at(0.55, NOW + 600_000);
    expect(sender.sent).toHaveLength(1);
    await at(0.72, NOW + 900_000);
    expect(sender.sent).toHaveLength(2);
    await at(0.75, NOW + 1_200_000);
    expect(sender.sent).toHaveLength(2);
    // The next day: the 50 % e-mail again.
    resetLimitsCache();
    await at(0.55, MIDNIGHT + 300_000);
    expect(sender.sent).toHaveLength(3);
  });

  it('engages at the threshold, puts the live room to sleep and releases at 00:00 UTC', async () => {
    await setPlan('free');
    const roomId = await newRoom();
    // The room had a stream today: the monitor finds it from D1 without waking anything.
    await env.DB.prepare(
      `INSERT INTO stream_starts (stream_id, space_id, room_id, user_id, started_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(`st_${roomId}`, SPACE_ID, roomId, USERS.member1.id, Date.now())
      .run();
    const { client } = await Client.join(roomId, USERS.member1.id);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }));
    });
    const now = Date.now();
    const result = await runLimitsMonitor(
      configured,
      now,
      fakeAnalytics(share('doRequests', 0.81)).fetchFn,
    );
    expect(result).toMatchObject({ status: 'stored', engagedNow: true, alerted: 80 });
    if (result.status !== 'stored') throw new Error('not stored');
    expect(result.state.engaged).toMatchObject({ metric: 'doRequests', by: 'monitor' });
    expect(result.slept?.rooms).toBeGreaterThanOrEqual(1);
    expect(result.slept?.failed).toBe(0);
    expect(await closed).toEqual({ code: 1013, reason: 'limits_brake' });
    expect(sender.sent.map((m) => m.subject)).toEqual([
      'Openlive paused: limits brake engaged (Durable Object requests)',
    ]);
    // The room deleted its alarm and stays dormant: nothing re-arms it.
    await runInDurableObject(roomStub(roomId), async (_room: RoomDO, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
    // The Worker refuses its sockets (the isolate's copy was updated by the run).
    const res = await upgrade(roomId, USERS.member2.id);
    const ws = res.webSocket;
    if (!ws) throw new Error('no socket');
    const refused = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }));
    });
    ws.accept();
    expect(await refused).toEqual({ code: 1013, reason: 'limits_brake' });

    // The next day's run: the figures are low again, the brake releases by itself.
    const tomorrow = (result.state.engaged?.until ?? 0) + 60_000;
    const next = await runLimitsMonitor(
      configured,
      tomorrow,
      fakeAnalytics(share('doRequests', 0.01)).fetchFn,
    );
    expect(next.state).toEqual(NO_BRAKE);
    expect((await readBrakeRows(env.DB)).state).toEqual(NO_BRAKE);
  });

  it('without a token it does not query, and only lets a lapsed brake go', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const lapsed = { ...engagedByHand(NOW - 86_400_000) };
    await env.DB.prepare(
      `INSERT INTO platform_settings (key, value_json, updated_at) VALUES (?, ?, 0)`,
    )
      .bind(BRAKE_STATE_KEY, JSON.stringify(lapsed))
      .run();
    const result = await runLimitsMonitor(env, NOW);
    expect(result).toMatchObject({ status: 'skipped', state: NO_BRAKE });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('runs every 5 minutes; the usage copy and sweeps keep the quarter hours', () => {
    expect(onQuarterHour(Date.UTC(2026, 10, 7, 12, 0))).toBe(true);
    expect(onQuarterHour(Date.UTC(2026, 10, 7, 12, 5))).toBe(false);
    expect(onQuarterHour(Date.UTC(2026, 10, 7, 12, 10))).toBe(false);
    expect(onQuarterHour(Date.UTC(2026, 10, 7, 12, 15))).toBe(true);
  });
});

const api = (path: string, init: RequestInit & { user?: string } = {}) =>
  exports.default.fetch(`http://localhost/api${path}`, {
    ...init,
    headers: {
      ...(init.user ? { [DEV_USER_HEADER]: init.user } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });

describe('while the brake holds', () => {
  async function engage() {
    const res = await api('/admin/limits/brake/engage', { method: 'POST', user: USERS.owner.id });
    expect(res.status).toBe(200);
    return (await res.json()) as { state: { engaged: { until: number; by: string } | null } };
  }

  it('refuses the routes that reach a Durable Object, with the brake reason', async () => {
    const roomId = await newRoom();
    const view = await engage();
    expect(view.state.engaged).toMatchObject({ by: 'admin', until: expect.any(Number) });
    const res = await api(`/rtc/rooms/${roomId}/session`, {
      method: 'POST',
      user: USERS.member1.id,
      body: JSON.stringify({ sessionDescription: { type: 'offer', sdp: 'v=0\r\n' } }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      code: 'do_quota_exceeded',
      reason: 'limits_brake',
      releasesAt: view.state.engaged?.until,
    });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    // Hub and space sockets too, before anything else runs.
    for (const path of ['/ws/hub', `/ws/spaces/${SPACE_ID}`]) {
      const sock = await exports.default.fetch(`http://localhost${path}`, {
        headers: { Upgrade: 'websocket', [DEV_USER_HEADER]: USERS.member1.id },
      });
      expect(sock.status).toBe(101);
      const ws = sock.webSocket;
      if (!ws) throw new Error('no socket');
      const frames: string[] = [];
      const closed = new Promise<string>((resolve) => {
        ws.addEventListener('message', (e) => {
          frames.push(e.data as string);
        });
        ws.addEventListener('close', (e) => resolve(e.reason));
      });
      ws.accept();
      expect(await closed).toBe('limits_brake');
      expect(JSON.parse(frames[0] ?? '{}')).toMatchObject({
        payload: { code: 'do_quota_exceeded', reason: 'limits_brake' },
      });
    }
  });

  it('keeps login, /api/me and the admin panel working, and releases by hand', async () => {
    await engage();
    expect((await api('/me', { user: USERS.member1.id })).status).toBe(200);
    expect((await api('/admin/limits/brake', { user: USERS.owner.id })).status).toBe(200);
    expect((await api('/admin/overview', { user: USERS.owner.id })).status).toBe(200);
    expect((await api('/auth/policy')).status).toBe(200);
    // Not for anyone else.
    expect(
      (await api('/admin/limits/brake/release', { method: 'POST', user: USERS.member1.id })).status,
    ).toBe(403);
    const released = await api('/admin/limits/brake/release', {
      method: 'POST',
      user: USERS.owner.id,
    });
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({
      state: { engaged: null, releasedUntil: expect.any(Number) },
    });
    const roomId = await newRoom();
    const { client } = await Client.join(roomId, USERS.member1.id);
    client.ws.close();
    const audit = await env.DB.prepare(
      "SELECT action FROM audit_log WHERE action LIKE 'platform.limits_brake.%' ORDER BY created_at",
    ).all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toContain('platform.limits_brake.release');
  });

  it('lapses at its release time without waiting for the cron', async () => {
    // Engaged by hand on a day long gone: its 00:00 UTC release has passed.
    forgetBrakeState(engagedByHand(Date.UTC(2020, 0, 1)));
    const roomId = await newRoom();
    const { client } = await Client.join(roomId, USERS.member1.id);
    client.ws.close();
  });

  it('a room alarm checks the brake itself and goes dormant', async () => {
    const roomId = await newRoom();
    const stub = roomStub(roomId);
    await runInDurableObject(stub, async (_room: RoomDO, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    forgetBrakeState(engagedByHand(Date.now()));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_room: RoomDO, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('saves the setting, bounded, and turning it off releases it', async () => {
    await engage();
    const bad = await api('/admin/limits/brake', {
      method: 'PUT',
      user: USERS.owner.id,
      body: JSON.stringify({
        enabled: true,
        percent: 99,
        paid: { includedShare: true, usdPerDay: null },
      }),
    });
    expect(bad.status).toBe(400);
    const off = await api('/admin/limits/brake', {
      method: 'PUT',
      user: USERS.owner.id,
      body: JSON.stringify({
        enabled: false,
        percent: 60,
        paid: { includedShare: false, usdPerDay: 3 },
      }),
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({
      setting: { enabled: false, percent: 60, paid: { includedShare: false, usdPerDay: 3 } },
      state: { engaged: null },
      alertLevels: [50, 70, 90],
    });
  });
});
