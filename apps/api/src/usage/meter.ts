// SPDX-License-Identifier: AGPL-3.0-only
// D1 accounting for the usage meter: the estimate written
// by the RoomDO into usage_daily, and the real usage the cron copies into
// usage_real_daily.

import type { BillingCycle } from '@openlive/usage';
import type { DailyUsageRow } from './realtime-usage';

/** Adds an estimate to a space's day, creating the row on first use. */
export async function recordEstimate(
  db: D1Database,
  spaceId: string,
  day: string,
  gb: number,
  viewerMinutes: number,
  streamMinutes: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_daily (space_id, day, egress_gb_est, viewer_minutes, stream_minutes)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (space_id, day) DO UPDATE SET
         egress_gb_est = egress_gb_est + excluded.egress_gb_est,
         viewer_minutes = viewer_minutes + excluded.viewer_minutes,
         stream_minutes = stream_minutes + excluded.stream_minutes`,
    )
    .bind(spaceId, day, gb, viewerMinutes, streamMinutes)
    .run();
}

export interface MonthTotal {
  egressGB: number;
  viewerMinutes: number;
  streamMinutes: number;
}

/** The estimate over a billing cycle, for all spaces or one (the quota is per account). */
export async function monthTotal(
  db: D1Database,
  cycle: BillingCycle,
  spaceId?: string,
): Promise<MonthTotal> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(egress_gb_est), 0) AS egressGB,
              COALESCE(SUM(viewer_minutes), 0) AS viewerMinutes,
              COALESCE(SUM(stream_minutes), 0) AS streamMinutes
       FROM usage_daily
       WHERE day >= ?1 AND day < ?2 AND (?3 IS NULL OR space_id = ?3)`,
    )
    .bind(cycle.start, cycle.end, spaceId ?? null)
    .first<MonthTotal>();
  return row ?? { egressGB: 0, viewerMinutes: 0, streamMinutes: 0 };
}

/** Stores real usage rows, replacing each day's previous total. */
export async function recordRealUsage(
  db: D1Database,
  rows: readonly DailyUsageRow[],
  fetchedAt: number,
): Promise<void> {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO usage_real_daily (day, service, resource_id, egress_bytes, fetched_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (day, service, resource_id) DO UPDATE SET
       egress_bytes = excluded.egress_bytes,
       fetched_at = excluded.fetched_at`,
  );
  await db.batch(
    rows.map((r) =>
      stmt.bind(r.day, r.service, r.resourceId, Math.round(r.egressBytes), fetchedAt),
    ),
  );
}

/** Real SFU + TURN egress over a billing cycle, in GB (an upper bound). */
export async function realMonthTotalGB(db: D1Database, cycle: BillingCycle): Promise<number> {
  return (await realMonthTotal(db, cycle)) ?? 0;
}

/** Like realMonthTotalGB, but null when the cron stored nothing for the cycle (not configured). */
export async function realMonthTotal(db: D1Database, cycle: BillingCycle): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(egress_bytes), 0) AS bytes
       FROM usage_real_daily WHERE day >= ?1 AND day < ?2`,
    )
    .bind(cycle.start, cycle.end)
    .first<{ n: number; bytes: number }>();
  return row && row.n > 0 ? row.bytes / 1e9 : null;
}

export interface SpaceMonthTotal extends MonthTotal {
  spaceId: string;
}

/** The estimate over a billing cycle per space, for the spaces that used anything. */
export async function monthTotalsBySpace(
  db: D1Database,
  cycle: BillingCycle,
): Promise<SpaceMonthTotal[]> {
  const { results } = await db
    .prepare(
      `SELECT space_id AS spaceId, SUM(egress_gb_est) AS egressGB,
              SUM(viewer_minutes) AS viewerMinutes, SUM(stream_minutes) AS streamMinutes
       FROM usage_daily WHERE day >= ?1 AND day < ?2 GROUP BY space_id`,
    )
    .bind(cycle.start, cycle.end)
    .all<SpaceMonthTotal>();
  return results;
}
