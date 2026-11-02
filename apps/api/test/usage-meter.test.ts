// SPDX-License-Identifier: AGPL-3.0-only
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { billingCycle } from '@openlive/usage';
import { monthTotal, realMonthTotalGB, recordEstimate, recordRealUsage } from '../src/usage/meter';

const cycle = billingCycle(new Date('2026-10-27T12:00:00Z'), 11);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').bind(
      'mu1',
      'Ana',
      now,
    ),
    ...['ms1', 'ms2'].map((id) =>
      env.DB.prepare(
        'INSERT INTO spaces (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(id, id, id, 'mu1', now),
    ),
  ]);
});

describe('recordEstimate and monthTotal', () => {
  it('accumulates per space and day, and sums the billing cycle', async () => {
    await recordEstimate(env.DB, 'ms1', '2026-10-20', 10.5, 60, 15);
    await recordEstimate(env.DB, 'ms1', '2026-10-20', 2.25, 30, 5);
    await recordEstimate(env.DB, 'ms2', '2026-11-10', 4, 12, 3);
    // Outside the cycle [2026-10-11, 2026-11-11).
    await recordEstimate(env.DB, 'ms1', '2026-10-10', 100, 1, 1);
    await recordEstimate(env.DB, 'ms1', '2026-11-11', 100, 1, 1);

    const row = await env.DB.prepare(
      "SELECT * FROM usage_daily WHERE space_id = 'ms1' AND day = '2026-10-20'",
    ).first();
    expect(row).toMatchObject({ egress_gb_est: 12.75, viewer_minutes: 90, stream_minutes: 20 });

    expect(await monthTotal(env.DB, cycle)).toEqual({
      egressGB: 16.75,
      viewerMinutes: 102,
      streamMinutes: 23,
    });
    expect(await monthTotal(env.DB, cycle, 'ms2')).toEqual({
      egressGB: 4,
      viewerMinutes: 12,
      streamMinutes: 3,
    });
    expect(await monthTotal(env.DB, { start: '2025-01-01', end: '2025-02-01' })).toEqual({
      egressGB: 0,
      viewerMinutes: 0,
      streamMinutes: 0,
    });
  });
});

describe('recordRealUsage and realMonthTotalGB', () => {
  it('replaces each day total and sums SFU + TURN over the cycle', async () => {
    await recordRealUsage(
      env.DB,
      [
        { day: '2026-10-26', service: 'sfu', resourceId: 'app', egressBytes: 1e9 },
        { day: '2026-10-26', service: 'turn', resourceId: 'key', egressBytes: 5e8 },
      ],
      1,
    );
    await recordRealUsage(
      env.DB,
      [{ day: '2026-10-26', service: 'sfu', resourceId: 'app', egressBytes: 3e9 }],
      2,
    );
    await recordRealUsage(env.DB, [], 3);
    expect(await realMonthTotalGB(env.DB, cycle)).toBeCloseTo(3.5, 9);
    const row = await env.DB.prepare(
      "SELECT fetched_at FROM usage_real_daily WHERE service = 'sfu' AND day = '2026-10-26'",
    ).first<{ fetched_at: number }>();
    expect(row?.fetched_at).toBe(2);
  });
});
