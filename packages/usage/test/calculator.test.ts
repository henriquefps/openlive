// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  compareProfiles,
  costAboveFreeTier,
  DEFAULT_OVERHEADS,
  fullStreamHourGB,
  fullStreamHoursInFreeTier,
  joinGB,
  monthlyScenario,
  NO_OVERHEADS,
  overheads,
  viewerStreamGB,
} from '../src/calculator.js';

const HOUR = 3600;

describe('per-viewer egress (overheads off)', () => {
  it.each([
    [8, 3.6],
    [12, 5.4],
    [15, 6.75],
  ])('%d Mbps ≈ %d GB per hour', (mbps, gb) => {
    expect(viewerStreamGB(mbps, HOUR, NO_OVERHEADS)).toBeCloseTo(gb, 9);
  });
});

describe('table: 20 days a month, 2 h a day (overheads off)', () => {
  const base = { hoursPerStream: 2, days: 20 };
  it.each([
    [
      '1 streamer, 4 viewers, 8 Mbps',
      576,
      0,
      { streamsPerDay: 1, viewersPerStream: 4, bitrateMbps: 8 },
    ],
    [
      '1 streamer, 4 viewers, 15 Mbps',
      1080,
      4,
      { streamsPerDay: 1, viewersPerStream: 4, bitrateMbps: 15 },
    ],
    [
      '2 streamers, each seen by 3, 8 Mbps',
      864,
      0,
      { streamsPerDay: 2, viewersPerStream: 3, bitrateMbps: 8 },
    ],
    [
      '5 streamers, each seen by 4, 8 Mbps',
      2880,
      94,
      { streamsPerDay: 5, viewersPerStream: 4, bitrateMbps: 8 },
    ],
  ])('%s → %s GB, $%s', (_name, gb, usd, s) => {
    const r = monthlyScenario({ ...base, ...s }, NO_OVERHEADS);
    expect(r.totalGB).toBeCloseTo(gb, 6);
    expect(r.costUsd).toBeCloseTo(usd, 6);
  });
});

describe('example: 6 slots × 12 Mbps (overheads off)', () => {
  const max = { bitrateMbps: 12, slots: 6 };
  it('a full-stream hour is ≈ 32 GB', () => {
    expect(fullStreamHourGB(max, NO_OVERHEADS)).toBeCloseTo(32.4, 9);
  });
  it('≈ 31 full-stream hours fit in the free 1,000 GB', () => {
    const hours = fullStreamHoursInFreeTier(max, NO_OVERHEADS);
    expect(hours).toBeCloseTo(30.864, 3);
    expect(Math.round(hours)).toBe(31);
  });
  it('the editable scenario "2 streams a night, 2 h each, 4 viewers, 20 nights"', () => {
    const r = monthlyScenario(
      { streamsPerDay: 2, hoursPerStream: 2, viewersPerStream: 4, days: 20, bitrateMbps: 12 },
      NO_OVERHEADS,
    );
    expect(r.totalGB).toBeCloseTo(1728, 6);
    expect(r.gbAboveFree).toBeCloseTo(728, 6);
    expect(r.costUsd).toBeCloseTo(36.4, 6);
  });
});

describe('reference profiles', () => {
  it('overheads off: Economy 14.4 GB/h (≈ 69 h), Max 32.4 GB/h (≈ 31 h)', () => {
    const [economy, max] = compareProfiles(NO_OVERHEADS);
    expect(economy).toMatchObject({ id: 'economy' });
    expect(economy?.fullStreamHourGB).toBeCloseTo(14.4, 9);
    expect(economy?.fullStreamHoursInFreeTier).toBeCloseTo(69.444, 3);
    expect(max).toMatchObject({ id: 'max' });
    expect(max?.fullStreamHourGB).toBeCloseTo(32.4, 9);
    expect(max?.fullStreamHoursInFreeTier).toBeCloseTo(30.864, 3);
  });

  it('overheads on: Economy 21.66 GB/h (≈ 46 h), Max 48.735 GB/h (≈ 20.5 h)', () => {
    const [economy, max] = compareProfiles(DEFAULT_OVERHEADS);
    // 4 × 3.6 GB × 1.5 + 4 joins × 15 MB
    expect(economy?.fullStreamHourGB).toBeCloseTo(21.66, 9);
    expect(economy?.fullStreamHoursInFreeTier).toBeCloseTo(46.168, 3);
    // 6 × 5.4 GB × 1.5 + 6 joins × 22.5 MB (15 MB scaled from 8 to 12 Mbps)
    expect(max?.fullStreamHourGB).toBeCloseTo(48.735, 9);
    expect(max?.fullStreamHoursInFreeTier).toBeCloseTo(20.519, 3);
  });
});

describe('overheads on (Proposed)', () => {
  it('billed egress is 1.5× the layer bitrate', () => {
    expect(viewerStreamGB(8, HOUR, DEFAULT_OVERHEADS)).toBeCloseTo(5.4, 9);
  });

  it('a join costs 15 MB at 8 Mbps, scaled linearly by bitrate', () => {
    expect(joinGB(8, DEFAULT_OVERHEADS)).toBeCloseTo(0.015, 12);
    expect(joinGB(12, DEFAULT_OVERHEADS)).toBeCloseTo(0.0225, 12);
    expect(joinGB(8, NO_OVERHEADS)).toBe(0);
  });

  it.each([
    [
      '1 streamer, 4 viewers, 8 Mbps',
      865.2,
      0,
      { streamsPerDay: 1, viewersPerStream: 4, bitrateMbps: 8 },
    ],
    [
      '1 streamer, 4 viewers, 15 Mbps',
      1622.25,
      31.1125,
      { streamsPerDay: 1, viewersPerStream: 4, bitrateMbps: 15 },
    ],
    [
      '2 streamers, each seen by 3, 8 Mbps',
      1297.8,
      14.89,
      { streamsPerDay: 2, viewersPerStream: 3, bitrateMbps: 8 },
    ],
    [
      '5 streamers, each seen by 4, 8 Mbps',
      4326,
      166.3,
      { streamsPerDay: 5, viewersPerStream: 4, bitrateMbps: 8 },
    ],
  ])('table row "%s" → %s GB, $%s', (_name, gb, usd, s) => {
    const r = monthlyScenario({ hoursPerStream: 2, days: 20, ...s }, DEFAULT_OVERHEADS);
    expect(r.totalGB).toBeCloseTo(gb, 6);
    expect(r.costUsd).toBeCloseTo(usd, 6);
  });

  it('counts extra joins per viewer', () => {
    const s = { streamsPerDay: 1, hoursPerStream: 0, viewersPerStream: 4, days: 1, bitrateMbps: 8 };
    expect(monthlyScenario({ ...s, joinsPerViewer: 3 }, DEFAULT_OVERHEADS).totalGB).toBeCloseTo(
      0.18,
      12,
    );
  });

  it('the flag turns them off, and single constants can be overridden', () => {
    expect(overheads(false)).toEqual(NO_OVERHEADS);
    expect(overheads(true)).toEqual(DEFAULT_OVERHEADS);
    expect(overheads(true, { bitrateMultiplier: 1.4 })).toEqual({
      ...DEFAULT_OVERHEADS,
      bitrateMultiplier: 1.4,
    });
  });
});

describe('cost above the free tier', () => {
  it('is $0.05 per GB above 1,000 GB and never negative', () => {
    expect(costAboveFreeTier(999)).toEqual({ gbAboveFree: 0, usd: 0 });
    expect(costAboveFreeTier(1000)).toEqual({ gbAboveFree: 0, usd: 0 });
    expect(costAboveFreeTier(1200).usd).toBeCloseTo(10, 9);
  });
});
