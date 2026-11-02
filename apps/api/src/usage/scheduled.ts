// SPDX-License-Identifier: AGPL-3.0-only
// The scheduled handler. The usage cron copies real Realtime egress
// for yesterday and today (UTC) into usage_real_daily. Inert until the
// instance has an Analytics token, the account id and the Realtime app id.

import { runSweeps } from '../maintenance/sweep';
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

/** Every cron tick: the usage copy and the housekeeping sweeps, each on its own. */
export const scheduled: ExportedHandlerScheduledHandler<Env> = async (controller, env) => {
  const now = new Date(controller.scheduledTime);
  let failure: unknown = null;
  try {
    await runUsageCron(env as Env & UsageCronEnv, now);
  } catch (err) {
    failure = err;
  }
  await runSweeps(env, now.getTime());
  // A failed usage copy still marks the run as failed, after the sweeps had their turn.
  if (failure !== null) throw failure;
};
