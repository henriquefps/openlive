// SPDX-License-Identifier: AGPL-3.0-only
// The instance's quota right now: the cycle from the admin's reset
// day, the month's estimate from usage_daily, the real usage from usage_real_daily, the brake
// state from quotaState() against the admin's monthly limit, and the projection to the cycle's end.
// The admin overview shows all of it; /api/me exposes only the codes and the limit.

import {
  type BillingCycle,
  billingCycle,
  type BrakeSettings,
  type Budget,
  budgetLimitGB,
  type CycleProjection,
  DEFAULT_BRAKE_SETTINGS,
  projectCycle,
  quotaState,
  type QuotaState,
} from '@openlive/usage';
import { type PlatformSettings, platformSettings } from '../db/platform';
import { type MonthTotal, monthTotal, realMonthTotal } from './meter';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InstanceQuota {
  cycle: BillingCycle;
  /** Whole UTC days until the cycle turns over, today included. */
  daysLeft: number;
  budget: Budget;
  brakes: BrakeSettings;
  estimate: MonthTotal;
  /** Real egress (GB) reported by Cloudflare, or null when nothing was fetched this cycle. */
  realGB: number | null;
  state: QuotaState;
  projection: CycleProjection;
}

export async function instanceQuota(
  db: D1Database,
  now: Date,
  settings?: PlatformSettings,
): Promise<InstanceQuota> {
  const s = settings ?? (await platformSettings(db));
  const cycle = billingCycle(now, s.cycleResetDay);
  const brakes: BrakeSettings = {
    ...DEFAULT_BRAKE_SETTINGS,
    quotaGB: budgetLimitGB(s.budget),
    mode: s.quotaMode,
    autoEconomy: s.autoEconomy,
  };
  const [estimate, realGB] = await Promise.all([monthTotal(db, cycle), realMonthTotal(db, cycle)]);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const state = quotaState({ estimatedGB: estimate.egressGB, realGB }, brakes);
  return {
    cycle,
    daysLeft: Math.round((Date.parse(`${cycle.end}T00:00:00Z`) - today) / DAY_MS),
    budget: s.budget,
    brakes,
    estimate,
    realGB,
    state,
    projection: projectCycle(state.usedGB, now, cycle, brakes),
  };
}
