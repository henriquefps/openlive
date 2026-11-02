// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFAULT_OVERHEADS, NO_OVERHEADS, PRICE_USD_PER_GB } from '../src/calculator.js';
import {
  applyLimits,
  DEFAULT_SCENARIO,
  type EstimateScenario,
  type EstimateSettings,
  estimateMonth,
  estimateWorkers,
  voiceHourGB,
} from '../src/estimate.js';

// The /admin/settings estimate. Overheads off unless a test says so, so the numbers are the plain
// formula: pulls × bitrate × time.

/** 1440p60 with the 12 Mb/s default cap, 6 viewers, 5 streams, 6 cameras, the free tier. */
const SETTINGS: EstimateSettings = {
  presets: ['text', 'game', 'max'],
  maxBitrateKbps: 12_000,
  maxViewersPerStream: 6,
  maxStreamsPerRoom: 5,
  maxCamerasPerRoom: 6,
  allowAv1: false,
  presetCodecs: {},
  capabilities: { stream: true, voice: true, camera: true },
  overheads: NO_OVERHEADS,
  limitGB: 1000,
  autoEconomy: true,
};

/** GB of one viewer-hour at `kbps`. */
const hourAt = (kbps: number) => ((kbps * 1000) / 8) * 3600 * 1e-9;

const month = (s: Partial<EstimateSettings> = {}, sc: Partial<EstimateScenario> = {}) =>
  estimateMonth({ ...SETTINGS, ...s }, { ...DEFAULT_SCENARIO, ...sc });

describe('estimateMonth', () => {
  it('the default group: 1 streamer, 4 friends on Game, 5 in voice, 2 h a day, 20 days', () => {
    const e = month();
    // Game's top layer under the 12 Mb/s cap: 8,000 − (12,628 − 12,000) = 7,372 kbps.
    expect(e.viewerKbps).toEqual({ h264: 7372, av1: null });
    expect(e.breakdown.streamsH264GB).toBeCloseTo(4 * 2 * 20 * hourAt(7372), 9);
    expect(e.breakdown.streamsH264GB).toBeCloseTo(530.78, 2);
    expect(e.breakdown.streamsAv1GB).toBe(0);
    // 5 × 4 microphone pulls at 32 kbps.
    expect(e.breakdown.voiceGB).toBeCloseTo(20 * 2 * 20 * hourAt(32), 9);
    expect(e.breakdown.camerasGB).toBe(0);
    expect(e.totalGB).toBeCloseTo(542.3, 1);
    expect(e.costUsd).toBe(0);
    expect(e.fits).toBe(true);
    // 1,000 GB / 271.2 GB per hour-a-day.
    expect(e.hoursPerDayThatFit).toBeCloseTo(3.69, 2);
    expect(e.economy).toBeNull();
    expect(e.clamped).toEqual([]);
  });

  it('splits viewers between H.264 and AV1 by the share that decodes it, per mode', () => {
    const save = month({ allowAv1: true });
    expect(save.viewerKbps).toEqual({ h264: 7372, av1: 7372 * 0.65 });
    // 70 % of the 4 viewers on AV1.
    expect(save.breakdown.streamsH264GB).toBeCloseTo(1.2 * 40 * hourAt(7372), 9);
    expect(save.breakdown.streamsAv1GB).toBeCloseTo(2.8 * 40 * hourAt(7372 * 0.65), 9);
    expect(save.totalGB).toBeLessThan(month().totalGB);

    const quality = month({ allowAv1: true, presetCodecs: { game: 'av1Quality' } });
    expect(quality.viewerKbps.av1).toBe(7372);
    expect(quality.totalGB).toBeCloseTo(month().totalGB, 9);

    const h264 = month({ allowAv1: true, presetCodecs: { game: 'h264' } });
    expect(h264.breakdown.streamsAv1GB).toBe(0);
    expect(h264.viewerKbps.av1).toBeNull();

    const nobody = month({ allowAv1: true }, { av1Share: 0 });
    expect(nobody.totalGB).toBeCloseTo(month().totalGB, 9);
  });

  it('prices the GB above the free tier and says how many hours a day fit the limit', () => {
    // 3 streamers × 6 friends on Max (12 Mb/s cap: 12,000 − 4,628 = 7,372 kbps), 2 h, 30 days.
    const e = month(
      {},
      { streamers: 3, viewers: 6, preset: 'max', hoursPerDay: 2, daysPerMonth: 30 },
    );
    expect(e.viewerKbps.h264).toBe(7372);
    expect(e.totalGB).toBeGreaterThan(1000);
    expect(e.gbAboveFree).toBeCloseTo(e.totalGB - 1000, 9);
    expect(e.costUsd).toBeCloseTo(e.gbAboveFree * PRICE_USD_PER_GB, 9);
    expect(e.fits).toBe(false);
    expect(e.hoursPerDayThatFit).toBeCloseTo((1000 / e.totalGB) * 2, 9);

    const bigger = month(
      { limitGB: 5000 },
      { streamers: 3, viewers: 6, preset: 'max', hoursPerDay: 2, daysPerMonth: 30 },
    );
    expect(bigger.fits).toBe(true);
    expect(bigger.hoursPerDayThatFit).toBeCloseTo((5000 / bigger.totalGB) * 2, 9);
  });

  it('unlimited always fits; the hours that fit are the free tier’s', () => {
    const e = month(
      { limitGB: null },
      { streamers: 5, viewers: 6, hoursPerDay: 8, daysPerMonth: 31 },
    );
    expect(e.fits).toBe(true);
    expect(e.limitGB).toBeNull();
    expect(e.hoursPerDayThatFit).toBeCloseTo((1000 / e.totalGB) * 8, 9);
    expect(e.economy).toBeNull();
  });

  it('economy mode past 90 % of the limit runs the rest of the month on the middle layer', () => {
    const scenario = { viewers: 6, hoursPerDay: 4, daysPerMonth: 30 };
    const e = month({}, scenario);
    expect(e.totalGB).toBeGreaterThan(900);
    expect(e.economy).not.toBeNull();
    expect(e.economy?.startsAtGB).toBe(900);
    // Streams at 3,500 instead of 7,372 kbps, voice unchanged.
    const day = (kbps: number) => 6 * 4 * hourAt(kbps) + 20 * 4 * hourAt(32);
    const ratio = day(3500) / day(7372);
    expect(e.economy?.totalGB).toBeCloseTo(900 + (e.totalGB - 900) * ratio, 9);
    expect(month({ autoEconomy: false }, scenario).economy).toBeNull();
  });

  it('adds the overheads when they are on', () => {
    const on = month({ overheads: DEFAULT_OVERHEADS });
    expect(on.totalGB).toBeGreaterThan(month().totalGB * 1.5);
  });

  it('cameras: each pulled by everyone else in voice on the strip layer', () => {
    const e = month({}, { cameras: 3 });
    // 3 cameras × 4 others at 150 kbps.
    expect(e.breakdown.camerasGB).toBeCloseTo(12 * 2 * 20 * hourAt(150), 9);
  });
});

describe('applyLimits', () => {
  it('holds the scenario to the settings and says what it cut', () => {
    const { applied, clamped } = applyLimits(
      { ...SETTINGS, maxViewersPerStream: 3, maxStreamsPerRoom: 2, maxCamerasPerRoom: 2 },
      { ...DEFAULT_SCENARIO, viewers: 10, streamers: 4, cameras: 5, preset: 'native' },
    );
    expect(applied).toMatchObject({ viewers: 3, streamers: 2, cameras: 2, preset: 'max' });
    expect(clamped.sort()).toEqual(['cameras', 'preset', 'streamers', 'viewers']);
  });

  it('cameras never exceed the people in voice', () => {
    expect(
      applyLimits(SETTINGS, { ...DEFAULT_SCENARIO, voicePeople: 2, cameras: 6 }).applied.cameras,
    ).toBe(2);
  });

  it('turns off what the capabilities do not allow', () => {
    const noVoice = applyLimits(
      { ...SETTINGS, capabilities: { stream: true, voice: false, camera: true } },
      { ...DEFAULT_SCENARIO, cameras: 2 },
    );
    expect(noVoice.applied).toMatchObject({ voicePeople: 0, cameras: 0 });
    expect(noVoice.clamped).toEqual(['voice', 'cameras']);
    const noCamera = applyLimits(
      { ...SETTINGS, capabilities: { stream: true, voice: true, camera: false } },
      { ...DEFAULT_SCENARIO, cameras: 2 },
    );
    expect(noCamera.applied.cameras).toBe(0);
    const noStream = applyLimits(
      { ...SETTINGS, capabilities: { stream: false, voice: true, camera: true } },
      DEFAULT_SCENARIO,
    );
    expect(noStream.applied.streamers).toBe(0);
    expect(noStream.clamped).toEqual(['stream']);
  });

  it('treats empty or negative inputs as zero', () => {
    const { applied } = applyLimits(SETTINGS, {
      ...DEFAULT_SCENARIO,
      viewers: Number.NaN,
      hoursPerDay: -2,
      av1Share: 3,
    });
    expect(applied).toMatchObject({ viewers: 0, hoursPerDay: 0, av1Share: 1 });
    expect(estimateMonth(SETTINGS, { ...DEFAULT_SCENARIO, hoursPerDay: 0 }).totalGB).toBe(0);
  });
});

describe('voiceHourGB', () => {
  it('5 people: 20 microphone pulls at 32 kbps', () => {
    expect(voiceHourGB(5, NO_OVERHEADS)).toBeCloseTo(20 * hourAt(32), 12);
    expect(voiceHourGB(1, NO_OVERHEADS)).toBe(0);
  });
});

describe('estimateWorkers', () => {
  it('scales the measured group hour (5 people: 547 rows written, 729 requests)', () => {
    const free = estimateWorkers(DEFAULT_SCENARIO, 'free');
    // 1 streamer + 4 friends, 2 hours: two group hours.
    expect(free.rowsWrittenPerDay).toBeCloseTo(1094, 9);
    expect(free.requestsPerDay).toBeCloseTo(1458, 9);
    expect(free.share).toBeCloseTo(0.01458, 9);
    expect(free.overageUsd).toBe(0);
  });

  it('on Paid, the month against the included amounts and the overage', () => {
    // 50 people for 24 h, 31 days: 240 group hours a day, ~5.4 million requests a month.
    const paid = estimateWorkers(
      { ...DEFAULT_SCENARIO, voicePeople: 50, hoursPerDay: 24, daysPerMonth: 31 },
      'paid',
    );
    const requests = 240 * 729 * 31;
    expect(paid.share).toBeCloseTo(requests / 1e6, 9);
    expect(paid.overageUsd).toBeCloseTo(((requests - 1e6) / 1e6) * 0.15, 9);
  });
});
