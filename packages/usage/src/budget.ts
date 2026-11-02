// SPDX-License-Identifier: AGPL-3.0-only
// The monthly usage budget: the limit the brakes act on. The free
// tier (1,000 GB, the default), three larger presets, a custom number of GB, or no limit at all.
// Above the free tier Cloudflare bills every GB, so each limit has a maximum cost.

import { FREE_TIER_GB, PRICE_USD_PER_GB } from './calculator.js';

export const BUDGET_KINDS = ['free', 'preset', 'custom', 'unlimited'] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

/** The preset limits above the free tier, in GB. */
export const BUDGET_PRESETS_GB = [1500, 2000, 5000] as const;
export type BudgetPresetGB = (typeof BUDGET_PRESETS_GB)[number];

/** Bounds of a custom limit: 100,000 GB costs about US$ 4,950 a month. */
export const CUSTOM_BUDGET_GB = { min: 1, max: 100_000 } as const;

export type Budget =
  | { kind: 'free' }
  | { kind: 'preset'; limitGB: BudgetPresetGB }
  | { kind: 'custom'; limitGB: number }
  | { kind: 'unlimited' };

export const DEFAULT_BUDGET: Budget = { kind: 'free' };

/** The monthly limit in GB, or null when there is none. */
export function budgetLimitGB(b: Budget): number | null {
  switch (b.kind) {
    case 'free':
      return FREE_TIER_GB;
    case 'preset':
    case 'custom':
      return b.limitGB;
    case 'unlimited':
      return null;
  }
}

/** What a month at the limit costs: the GB above the free tier at US$ 0.05 each. */
export function maxMonthlyCostUsd(limitGB: number, freeGB = FREE_TIER_GB): number {
  return Math.max(0, limitGB - freeGB) * PRICE_USD_PER_GB;
}

/** The limit a monthly amount of US$ buys: the free tier plus what the amount pays for. */
export function limitForUsd(usd: number, freeGB = FREE_TIER_GB): number {
  return freeGB + Math.max(0, usd) / PRICE_USD_PER_GB;
}

/** A budget from a stored or submitted value, or null when it is not a valid one. */
export function parseBudget(value: unknown): Budget | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, limitGB } = value as { kind?: unknown; limitGB?: unknown };
  switch (kind) {
    case 'free':
    case 'unlimited':
      return { kind };
    case 'preset':
      return BUDGET_PRESETS_GB.includes(limitGB as BudgetPresetGB)
        ? { kind, limitGB: limitGB as BudgetPresetGB }
        : null;
    case 'custom':
      return typeof limitGB === 'number' &&
        Number.isInteger(limitGB) &&
        limitGB >= CUSTOM_BUDGET_GB.min &&
        limitGB <= CUSTOM_BUDGET_GB.max
        ? { kind, limitGB }
        : null;
    default:
      return null;
  }
}
