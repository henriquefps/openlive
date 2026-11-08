// SPDX-License-Identifier: AGPL-3.0-only
// The scheduled handler. The cron fires every 5 minutes: each run
// is the limits monitor, and every third one (on the quarter hour) also the usage
// copy and the housekeeping sweeps, which kept their 15 minutes. The usage cron copies real
// Realtime egress for yesterday and today (UTC) into usage_real_daily. Inert until the instance
// has an Analytics token, the account id and the Realtime app id.

import { runSweeps } from '../maintenance/sweep';
import { runLimitsMonitor } from './limits-monitor';
import { recordRealUsage } from './meter';
import { fetchRealtimeUsage } from './realtime-usage';

/** Secrets and vars the cron reads; all optional so the Worker runs without them. */
export interface UsageCronEnv {
  DB: D1Database;
  /** API token with Account → Account Analytics → Read. */
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  REALTIME_APP_ID?: string | undefined;
  /** When set, only this TURN key is counted. */
  TURN_KEY_ID?: string | undefined;
}

export type UsageCronResult =
  | { status: 'skipped'; missing: string[] }
  | { status: 'stored'; rows: number; totalEgressBytes: number };

export async function runUsageCron(
  env: UsageCronEnv,
  now: Date,
  fetchFn: typeof fetch = fetch,
): Promise<UsageCronResult> {
  const {
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    REALTIME_APP_ID: appId,
  } = env;
  if (!token || !accountId || !appId) {
    const missing = Object.entries({
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      REALTIME_APP_ID: appId,
    })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    // Once a day (the first run after 00:00 UTC), not on every run: an instance without
    // Realtime is a normal state, and each line is a Workers Logs event.
    if (now.getUTCHours() === 0 && now.getUTCMinutes() < 15) {
      console.log(`usage cron: skipped, not configured (missing ${missing.join(', ')})`);
    }
    return { status: 'skipped', missing };
  }

  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const usage = await fetchRealtimeUsage(
    token,
    {
      accountId,
      appId,
      start,
      end: now,
      ...(env.TURN_KEY_ID ? { turnKeyIds: [env.TURN_KEY_ID] } : {}),
    },
    fetchFn,
  );
  await recordRealUsage(env.DB, usage.rows, now.getTime());
  return { status: 'stored', rows: usage.rows.length, totalEgressBytes: usage.totalEgressBytes };
}

/** The cron's period, and the usage copy's and sweeps' (they run on the quarter hours). */
export const CRON_PERIOD_MS = 5 * 60_000;
export const QUARTER_MS = 15 * 60_000;

/** Whether a run at `now` is the quarter hour's (the first run in each 15 minutes of the clock). */
export const onQuarterHour = (now: number): boolean => now % QUARTER_MS < CRON_PERIOD_MS;

/** Every cron tick: the limits monitor, then on the quarter hour the usage copy and the sweeps. */
export const scheduled: ExportedHandlerScheduledHandler<Env> = async (controller, env) => {
  const now = new Date(controller.scheduledTime);
  const failures: unknown[] = [];
  try {
    await runLimitsMonitor(env, now.getTime());
  } catch (err) {
    console.error('limits monitor failed', err);
    failures.push(err);
  }
  if (onQuarterHour(now.getTime())) {
    try {
      await runUsageCron(env as Env & UsageCronEnv, now);
    } catch (err) {
      failures.push(err);
    }
    await runSweeps(env, now.getTime());
  }
  // A failed step still marks the run as failed, after the others had their turn.
  if (failures.length > 0) throw failures[0];
};
