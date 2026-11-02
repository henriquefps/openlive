// SPDX-License-Identifier: AGPL-3.0-only
// Quota brakes 1–4: warnings at 70 %, 90 % and 100 % of
// the admin's monthly limit, a separate notice once usage passes the free tier, economy mode above
// 90 %, block of new streams at the limit with a safety margin, a grace period for running
// streams, and the estimated cost above the free tier. Pure: returns codes, never text.

import { costAboveFreeTier, FREE_TIER_GB } from './calculator.js';

export type QuotaMode = 'block' | 'alerts_only';

export interface BrakeSettings {
  /** Monthly limit in GB (default: the free tier); null for an unlimited budget. */
  quotaGB: number | null;
  /** "Block new streams" (default) or "alerts only". */
  mode: QuotaMode;
  /** Block when usage reaches this fraction of the limit, to absorb estimation error. */
  safetyMargin: number;
  /** How long running streams continue after the block (default 10 minutes). */
  graceMinutes: number;
  /** Brake 3: enter economy mode above 90 % of the limit (the admin can turn it off). */
  autoEconomy: boolean;
}

export const DEFAULT_BRAKE_SETTINGS: BrakeSettings = {
  quotaGB: FREE_TIER_GB,
  mode: 'block',
  safetyMargin: 0.95,
  graceMinutes: 10,
  autoEconomy: true,
};

/**
 * Brake 3's cap: the most a stream publishes in economy mode, video and audio together.
 * Matches the calculator's "economy" stream (1080p60 at 8 Mbps).
 */
export const ECONOMY_CAP = { maxHeight: 1080, maxBitrateKbps: 8000 } as const;

export type QuotaLevel = 'ok' | 'warn_70' | 'warn_90' | 'warn_100';

export interface QuotaInput {
  estimatedGB: number;
  /** Real egress reported by Cloudflare, when known. */
  realGB?: number | null;
}

export interface QuotaState {
  /** Relative to the chosen limit; always 'ok' without one. */
  level: QuotaLevel;
  /** The usage the brakes act on: the larger of the estimate and the real usage. */
  usedGB: number;
  /** usedGB over the limit, or null without one. */
  usedFraction: number | null;
  source: 'estimate' | 'real';
  /**
   * Usage is past the free tier, so Cloudflare bills it: a notice of its own, whatever
   * the limit, including an unlimited one.
   */
  freeTierExceeded: boolean;
  /** Brake 3: cap at 1080p 8 Mbps and the middle layer by default. */
  economyMode: boolean;
  /** Brake 4: new streams are refused until the cycle turns over. */
  blockNewStreams: boolean;
  /** Running streams get a warning and end after the grace period. */
  runningStreams: { action: 'none' } | { action: 'end_after_grace'; graceMinutes: number };
  /** Mandatory in-app cost warning. */
  cost: { gbAboveFree: number; usd: number };
}

function levelFor(fraction: number | null): QuotaLevel {
  if (fraction === null) return 'ok';
  if (fraction >= 1) return 'warn_100';
  if (fraction >= 0.9) return 'warn_90';
  if (fraction >= 0.7) return 'warn_70';
  return 'ok';
}

export function quotaState(
  input: QuotaInput,
  settings: BrakeSettings = DEFAULT_BRAKE_SETTINGS,
): QuotaState {
  const real = input.realGB ?? null;
  const source = real !== null && real > input.estimatedGB ? 'real' : 'estimate';
  const usedGB = source === 'real' && real !== null ? real : input.estimatedGB;
  const limit = settings.quotaGB;
  const usedFraction = limit === null ? null : limit > 0 ? usedGB / limit : Infinity;

  const blockNewStreams =
    settings.mode === 'block' && usedFraction !== null && usedFraction >= settings.safetyMargin;

  return {
    level: levelFor(usedFraction),
    usedGB,
    usedFraction,
    source,
    freeTierExceeded: usedGB > FREE_TIER_GB,
    economyMode: settings.autoEconomy && usedFraction !== null && usedFraction > 0.9,
    blockNewStreams,
    runningStreams: blockNewStreams
      ? { action: 'end_after_grace', graceMinutes: settings.graceMinutes }
      : { action: 'none' },
    cost: costAboveFreeTier(usedGB),
  };
}

/** When a running stream must end, given when the block started. */
export function graceDeadline(blockedAtMs: number, settings: BrakeSettings): number {
  return blockedAtMs + settings.graceMinutes * 60_000;
}

/** A billing cycle as UTC days, `start` inclusive and `end` exclusive ('YYYY-MM-DD'). */
export interface BillingCycle {
  start: string;
  end: string;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The reset day in a given month, clamped to the month's last day (31 → Feb 28/29). */
function resetDate(year: number, month: number, resetDay: number): Date {
  const y = year + Math.floor(month / 12);
  const m = ((month % 12) + 12) % 12;
  return new Date(Date.UTC(y, m, Math.min(resetDay, daysInMonth(y, m))));
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The cycle containing `now`, for a cycle that turns over on `resetDay` (1–31)
 * of each month (brake 4: follows the Cloudflare account cycle). In months
 * shorter than `resetDay` the cycle turns over on the last day.
 */
export function billingCycle(now: Date, resetDay: number): BillingCycle {
  if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31) {
    throw new RangeError(`resetDay must be an integer 1..31, got ${resetDay}`);
  }
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const thisMonth = resetDate(y, m, resetDay);
  const startMonth = now.getUTCDate() >= thisMonth.getUTCDate() ? m : m - 1;
  return {
    start: isoDay(resetDate(y, startMonth, resetDay)),
    end: isoDay(resetDate(y, startMonth + 1, resetDay)),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How much of the cycle has passed at `now`, from 0 to 1. Until a whole day has passed it counts
 * as one day, so the first minutes' usage does not project an absurd month.
 */
export function cycleElapsedFraction(now: Date, cycle: BillingCycle): number {
  const start = Date.parse(`${cycle.start}T00:00:00Z`);
  const end = Date.parse(`${cycle.end}T00:00:00Z`);
  const length = end - start;
  if (!(length > 0)) return 1;
  const elapsed = Math.min(Math.max(now.getTime() - start, DAY_MS), length);
  return elapsed / length;
}

export interface CycleProjection {
  /** The cycle's elapsed fraction the projection divides by. */
  elapsedFraction: number;
  /** The month's usage if it keeps the pace so far (linear). */
  projectedGB: number;
  /** Block mode stops new streams at the limit, so the projection stops there too. */
  cappedAtLimit: boolean;
  /** What the projected usage costs above the free tier. */
  cost: { gbAboveFree: number; usd: number };
}

/**
 * A simple projection to the end of the cycle: the usage the brakes act on (the larger of the
 * estimate and the real usage) divided by the cycle's elapsed fraction.
 */
export function projectCycle(
  usedGB: number,
  now: Date,
  cycle: BillingCycle,
  settings: Pick<BrakeSettings, 'quotaGB' | 'mode'> = DEFAULT_BRAKE_SETTINGS,
): CycleProjection {
  const elapsedFraction = cycleElapsedFraction(now, cycle);
  const linear = usedGB / elapsedFraction;
  const cap = settings.mode === 'block' ? settings.quotaGB : null;
  const cappedAtLimit = cap !== null && linear > Math.max(cap, usedGB);
  const projectedGB = cappedAtLimit ? Math.max(cap, usedGB) : linear;
  return { elapsedFraction, projectedGB, cappedAtLimit, cost: costAboveFreeTier(projectedGB) };
}
