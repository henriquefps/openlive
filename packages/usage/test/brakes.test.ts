// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  billingCycle,
  type BrakeSettings,
  cycleElapsedFraction,
  DEFAULT_BRAKE_SETTINGS,
  graceDeadline,
  projectCycle,
  quotaState,
} from '../src/brakes.js';
import { type Budget, budgetLimitGB } from '../src/budget.js';

describe('quotaState', () => {
  it.each([
    [0, 'ok', false, false],
    [699, 'ok', false, false],
    [700, 'warn_70', false, false],
    [899, 'warn_70', false, false],
    [900, 'warn_90', false, false],
    [901, 'warn_90', true, false],
    [949, 'warn_90', true, false],
    [950, 'warn_90', true, true],
    [1000, 'warn_100', true, true],
    [1500, 'warn_100', true, true],
  ] as const)('%d GB → %s, economy %s, block %s', (gb, level, economy, block) => {
    const s = quotaState({ estimatedGB: gb });
    expect(s.level).toBe(level);
    expect(s.economyMode).toBe(economy);
    expect(s.blockNewStreams).toBe(block);
  });

  it('gives running streams the grace period when blocking', () => {
    expect(quotaState({ estimatedGB: 100 }).runningStreams).toEqual({ action: 'none' });
    expect(quotaState({ estimatedGB: 960 }).runningStreams).toEqual({
      action: 'end_after_grace',
      graceMinutes: 10,
    });
    expect(graceDeadline(1_000, DEFAULT_BRAKE_SETTINGS)).toBe(1_000 + 600_000);
  });

  it('"alerts only" warns and shows the cost but never blocks', () => {
    const s = quotaState({ estimatedGB: 1200 }, { ...DEFAULT_BRAKE_SETTINGS, mode: 'alerts_only' });
    expect(s.level).toBe('warn_100');
    expect(s.blockNewStreams).toBe(false);
    expect(s.runningStreams).toEqual({ action: 'none' });
    expect(s.cost.gbAboveFree).toBeCloseTo(200, 9);
    expect(s.cost.usd).toBeCloseTo(10, 9);
  });

  it('acts on the real usage when it is higher than the estimate', () => {
    const higher = quotaState({ estimatedGB: 600, realGB: 920 });
    expect(higher).toMatchObject({ source: 'real', usedGB: 920, level: 'warn_90' });
    const lower = quotaState({ estimatedGB: 600, realGB: 500 });
    expect(lower).toMatchObject({ source: 'estimate', usedGB: 600, level: 'ok' });
    expect(quotaState({ estimatedGB: 600, realGB: null }).source).toBe('estimate');
  });

  it('honours a custom quota, margin and grace', () => {
    const settings = {
      quotaGB: 500,
      mode: 'block',
      safetyMargin: 1,
      graceMinutes: 3,
      autoEconomy: true,
    } as const;
    expect(quotaState({ estimatedGB: 490 }, settings).blockNewStreams).toBe(false);
    const s = quotaState({ estimatedGB: 500 }, settings);
    expect(s).toMatchObject({ level: 'warn_100', blockNewStreams: true });
    expect(s.runningStreams).toEqual({ action: 'end_after_grace', graceMinutes: 3 });
    // Cost is against the 1,000 GB free tier, not the admin's quota.
    expect(s.cost.usd).toBe(0);
  });
});

describe('billingCycle', () => {
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

  it.each([
    ['2026-10-27', 11, '2026-10-11', '2026-11-11'],
    ['2026-10-11', 11, '2026-10-11', '2026-11-11'],
    ['2026-10-10', 11, '2026-09-11', '2026-10-11'],
    ['2026-10-27', 1, '2026-10-01', '2026-11-01'],
    ['2026-01-05', 11, '2025-12-11', '2026-01-11'],
    ['2026-12-31', 1, '2026-12-01', '2027-01-01'],
    // Reset day 31 clamps to the last day of shorter months.
    ['2026-02-28', 31, '2026-02-28', '2026-03-31'],
    ['2026-02-27', 31, '2026-01-31', '2026-02-28'],
    ['2026-03-30', 31, '2026-02-28', '2026-03-31'],
    ['2026-04-30', 31, '2026-04-30', '2026-05-31'],
    ['2028-02-29', 30, '2028-02-29', '2028-03-30'],
    ['2028-02-28', 30, '2028-01-30', '2028-02-29'],
    ['2026-03-29', 29, '2026-03-29', '2026-04-29'],
    ['2026-03-01', 29, '2026-02-28', '2026-03-29'],
  ])('%s with reset day %d → [%s, %s)', (now, day, start, end) => {
    expect(billingCycle(at(now), day)).toEqual({ start, end });
  });

  it('uses UTC days', () => {
    expect(billingCycle(new Date('2026-10-10T23:59:59Z'), 11).start).toBe('2026-09-11');
    expect(billingCycle(new Date('2026-10-11T00:00:00Z'), 11).start).toBe('2026-10-11');
  });

  it.each([0, 32, 1.5])('rejects reset day %d', (day) => {
    expect(() => billingCycle(at('2026-10-27'), day)).toThrow(RangeError);
  });
});

describe('quotaState for every budget', () => {
  const brakes = (budget: Budget, extra: Partial<BrakeSettings> = {}): BrakeSettings => ({
    ...DEFAULT_BRAKE_SETTINGS,
    quotaGB: budgetLimitGB(budget),
    ...extra,
  });
  const free: Budget = { kind: 'free' };
  const p1500: Budget = { kind: 'preset', limitGB: 1500 };
  const p5000: Budget = { kind: 'preset', limitGB: 5000 };
  const custom: Budget = { kind: 'custom', limitGB: 300 };
  const unlimited: Budget = { kind: 'unlimited' };

  // budget, GB used → level, free tier exceeded, economy, block (block mode, 95 % margin).
  it.each([
    [free, 600, 'ok', false, false, false],
    [free, 700, 'warn_70', false, false, false],
    [free, 950, 'warn_90', false, true, true],
    [free, 1001, 'warn_100', true, true, true],
    [p1500, 1000, 'ok', false, false, false],
    [p1500, 1001, 'ok', true, false, false],
    [p1500, 1050, 'warn_70', true, false, false],
    [p1500, 1350, 'warn_90', true, false, false],
    [p1500, 1351, 'warn_90', true, true, false],
    [p1500, 1425, 'warn_90', true, true, true],
    [p1500, 1500, 'warn_100', true, true, true],
    [p5000, 3499, 'ok', true, false, false],
    [p5000, 3500, 'warn_70', true, false, false],
    [p5000, 4750, 'warn_90', true, true, true],
    [custom, 210, 'warn_70', false, false, false],
    [custom, 285, 'warn_90', false, true, true],
    [unlimited, 999, 'ok', false, false, false],
    [unlimited, 1001, 'ok', true, false, false],
    [unlimited, 50_000, 'ok', true, false, false],
  ] as const)(
    '%o at %d GB → %s, past free %s, economy %s, block %s',
    (budget, gb, level, pastFree, economy, block) => {
      const s = quotaState({ estimatedGB: gb }, brakes(budget));
      expect(s).toMatchObject({ level, freeTierExceeded: pastFree, economyMode: economy });
      expect(s.blockNewStreams).toBe(block);
    },
  );

  it('shows the cost above the free tier in every budget, unlimited included', () => {
    for (const budget of [free, p1500, p5000, custom, unlimited]) {
      const s = quotaState({ estimatedGB: 1200 }, brakes(budget, { mode: 'alerts_only' }));
      expect(s.freeTierExceeded).toBe(true);
      expect(s.cost.gbAboveFree).toBeCloseTo(200, 9);
      expect(s.cost.usd).toBeCloseTo(10, 9);
    }
  });

  it('unlimited never blocks and has no fraction', () => {
    const s = quotaState({ estimatedGB: 90_000 }, brakes(unlimited));
    expect(s).toMatchObject({ level: 'ok', usedFraction: null, blockNewStreams: false });
    expect(s.runningStreams).toEqual({ action: 'none' });
  });

  it('alerts only warns at the chosen limit but never blocks', () => {
    const s = quotaState({ estimatedGB: 1600 }, brakes(p1500, { mode: 'alerts_only' }));
    expect(s).toMatchObject({ level: 'warn_100', economyMode: true, blockNewStreams: false });
    expect(s.cost.usd).toBeCloseTo(30, 9);
  });

  it('never enters economy mode when the admin turned it off', () => {
    const s = quotaState({ estimatedGB: 1450 }, brakes(p1500, { autoEconomy: false }));
    expect(s).toMatchObject({ level: 'warn_90', economyMode: false, blockNewStreams: true });
  });
});

describe('projectCycle', () => {
  const cycle = { start: '2026-10-01', end: '2026-10-31' }; // 30 days

  it.each([
    // now, elapsed fraction
    ['2026-10-01T00:00:00Z', 1 / 30], // less than a day counts as one
    ['2026-10-01T12:00:00Z', 1 / 30],
    ['2026-10-02T00:00:00Z', 1 / 30],
    ['2026-10-16T00:00:00Z', 0.5],
    ['2026-10-30T12:00:00Z', 29.5 / 30],
    ['2026-10-31T00:00:00Z', 1],
    ['2026-11-05T00:00:00Z', 1],
  ])('at %s the cycle is %d elapsed', (now, fraction) => {
    expect(cycleElapsedFraction(new Date(now), cycle)).toBeCloseTo(fraction, 9);
  });

  it('projects linearly on the elapsed fraction', () => {
    const p = projectCycle(412, new Date('2026-10-16T00:00:00Z'), cycle, {
      quotaGB: null,
      mode: 'alerts_only',
    });
    expect(p.projectedGB).toBeCloseTo(824, 9);
    expect(p.cappedAtLimit).toBe(false);
    expect(p.cost.usd).toBe(0);
    const later = projectCycle(800, new Date('2026-10-11T00:00:00Z'), cycle, {
      quotaGB: null,
      mode: 'alerts_only',
    });
    expect(later.projectedGB).toBeCloseTo(2400, 9);
    expect(later.cost.usd).toBeCloseTo(70, 9);
  });

  it('stops at the limit in block mode, never below what is already used', () => {
    const now = new Date('2026-10-11T00:00:00Z');
    const p = projectCycle(800, now, cycle, { quotaGB: 1500, mode: 'block' });
    expect(p).toMatchObject({ projectedGB: 1500, cappedAtLimit: true });
    expect(p.cost.usd).toBeCloseTo(25, 9);
    const over = projectCycle(1600, new Date('2026-10-31T00:00:00Z'), cycle, {
      quotaGB: 1500,
      mode: 'block',
    });
    expect(over).toMatchObject({ projectedGB: 1600, cappedAtLimit: false });
  });

  it('follows short and clamped cycles (reset day 31 in February)', () => {
    const feb = billingCycle(new Date('2026-03-14T00:00:00Z'), 31); // [02-28, 03-31): 31 days
    expect(feb).toEqual({ start: '2026-02-28', end: '2026-03-31' });
    expect(cycleElapsedFraction(new Date('2026-03-14T00:00:00Z'), feb)).toBeCloseTo(14 / 31, 9);
  });
});
