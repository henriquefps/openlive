// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { budgetLimitGB, limitForUsd, maxMonthlyCostUsd, parseBudget } from '../src/budget.js';

describe('budget', () => {
  it.each([
    [{ kind: 'free' }, 1000, 0],
    [{ kind: 'preset', limitGB: 1500 }, 1500, 25],
    [{ kind: 'preset', limitGB: 2000 }, 2000, 50],
    [{ kind: 'preset', limitGB: 5000 }, 5000, 200],
    [{ kind: 'custom', limitGB: 600 }, 600, 0],
    [{ kind: 'custom', limitGB: 3200 }, 3200, 110],
  ] as const)('%o → %d GB, at most US$ %d', (budget, gb, usd) => {
    expect(budgetLimitGB(budget)).toBe(gb);
    expect(maxMonthlyCostUsd(gb)).toBeCloseTo(usd, 9);
  });

  it('has no limit when unlimited', () => {
    expect(budgetLimitGB({ kind: 'unlimited' })).toBeNull();
  });

  it('converts a monthly US$ amount to GB above the free tier', () => {
    expect(limitForUsd(0)).toBe(1000);
    expect(limitForUsd(10)).toBeCloseTo(1200, 9);
    expect(limitForUsd(-5)).toBe(1000);
  });

  it.each([
    [{ kind: 'free' }, { kind: 'free' }],
    [{ kind: 'free', limitGB: 1500 }, { kind: 'free' }],
    [{ kind: 'unlimited' }, { kind: 'unlimited' }],
    [
      { kind: 'preset', limitGB: 2000 },
      { kind: 'preset', limitGB: 2000 },
    ],
    [{ kind: 'preset', limitGB: 1800 }, null],
    [
      { kind: 'custom', limitGB: 1 },
      { kind: 'custom', limitGB: 1 },
    ],
    [
      { kind: 'custom', limitGB: 100_000 },
      { kind: 'custom', limitGB: 100_000 },
    ],
    [{ kind: 'custom', limitGB: 0 }, null],
    [{ kind: 'custom', limitGB: 100_001 }, null],
    [{ kind: 'custom', limitGB: 12.5 }, null],
    [{ kind: 'custom' }, null],
    [{ kind: 'premium' }, null],
    ['free', null],
    [null, null],
  ])('parses %o as %o', (value, budget) => {
    expect(parseBudget(value)).toEqual(budget);
  });
});
