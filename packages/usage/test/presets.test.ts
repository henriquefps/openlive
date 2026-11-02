// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  compareProfiles,
  DEFAULT_OVERHEADS,
  NO_OVERHEADS,
  REFERENCE_PROFILE_120,
  REFERENCE_PROFILES,
} from '../src/calculator.js';
import {
  AV1_MODE_PERCENT,
  av1ModeOf,
  cappedTopKbps,
  codecKbps,
  isHighFrameRate,
  presetSendKbps,
  presetViewerKbps,
  QUALITY_PRESET_ORDER,
  QUALITY_PRESETS,
  viewerHourGB,
  viewerHourGBFor,
} from '../src/presets.js';

describe('the 120 fps presets', () => {
  it('Game 120 is 1080p120 at 14 Mbps and Max 120 is 1440p120 at 20 Mbps', () => {
    expect(QUALITY_PRESETS.game120).toEqual({ width: 1920, height: 1080, fps: 120, kbps: 14_000 });
    expect(QUALITY_PRESETS.max120).toEqual({ width: 2560, height: 1440, fps: 120, kbps: 20_000 });
    expect(QUALITY_PRESET_ORDER.filter(isHighFrameRate)).toEqual(['game120', 'max120']);
  });

  it('cost per viewer: ~6.3 and ~9 GB an hour without overheads (Game: 3.6)', () => {
    expect(viewerHourGB('game', NO_OVERHEADS)).toBeCloseTo(3.6, 9);
    expect(viewerHourGB('game120', NO_OVERHEADS)).toBeCloseTo(6.3, 9);
    expect(viewerHourGB('max120', NO_OVERHEADS)).toBeCloseTo(9, 9);
    // 1.5× plus one join of 15 MB × 20/8.
    expect(viewerHourGB('max120', DEFAULT_OVERHEADS)).toBeCloseTo(13.5 + 0.0375, 9);
  });

  it('every layer plus the audio is what the room cap must hold', () => {
    expect(presetSendKbps('game120', true)).toBe(14_000 + 3_500 + 1_000 + 128);
    expect(presetSendKbps('max120', false)).toBe(24_500);
  });

  it("the room's 13 Mbps default leaves the top layer far below the preset", () => {
    // 13,000 − (3,500 + 1,000 + 128) = 8,372: less than Game's 8 Mbps plus change.
    expect(cappedTopKbps('max120', true, 13_000)).toBe(8_372);
    expect(cappedTopKbps('game120', true, 13_000)).toBe(8_372);
    expect(cappedTopKbps('max120', true, 25_000)).toBe(20_000);
    expect(cappedTopKbps('max120', true, 0)).toBe(20_000);
    expect(viewerHourGB('max120', NO_OVERHEADS, 13_000)).toBeCloseTo((8.372 * 3600) / 8 / 1000, 9);
  });

  it('6 viewers of 1440p120 are ~54 GB an hour', () => {
    const [max120] = compareProfiles(NO_OVERHEADS, undefined, [REFERENCE_PROFILE_120]);
    expect(max120?.fullStreamHourGB).toBeCloseTo(54, 9);
    expect(compareProfiles(NO_OVERHEADS)).toHaveLength(REFERENCE_PROFILES.length);
  });
});

describe('AV1', () => {
  it("counts an AV1 viewer at its mode's share of the H.264 layer: 65 % to save data, 100 % for quality", () => {
    expect(AV1_MODE_PERCENT).toEqual({ save: 65, quality: 100 });
    expect(codecKbps(8000, 'av1')).toBe(5200);
    expect(codecKbps(8000, 'av1', 'save')).toBe(5200);
    expect(codecKbps(8000, 'av1', 'quality')).toBe(8000);
    expect(codecKbps(8000, 'h264', 'save')).toBe(8000);
    expect(codecKbps(8000, null)).toBe(8000);
  });

  it('maps each codec choice to its AV1 mode', () => {
    expect(av1ModeOf('av1Save')).toBe('save');
    expect(av1ModeOf('av1Quality')).toBe('quality');
    expect(av1ModeOf('h264')).toBeNull();
  });

  it('gives the calculator the per-viewer top-layer bitrate by preset and codec choice', () => {
    expect(presetViewerKbps('game', 'h264')).toBe(8000);
    expect(presetViewerKbps('game', 'av1Save')).toBe(5200);
    expect(presetViewerKbps('game', 'av1Quality')).toBe(8000);
    // Under a 12 Mb/s cap the top layer absorbs the cut first (12000 - 4628 = 7372).
    expect(presetViewerKbps('max', 'h264', 12_000)).toBe(7372);
    expect(presetViewerKbps('max', 'av1Save', 12_000)).toBeCloseTo(7372 * 0.65);
  });

  it("an hour of an AV1 top-layer viewer costs its mode's share of the H.264 one", () => {
    const h264 = viewerHourGBFor('game', 'h264', NO_OVERHEADS);
    expect(h264).toBeCloseTo(viewerHourGB('game', NO_OVERHEADS));
    expect(viewerHourGBFor('game', 'av1', NO_OVERHEADS)).toBeCloseTo(h264 * 0.65);
    expect(viewerHourGBFor('game', 'av1', NO_OVERHEADS, 0, 'quality')).toBeCloseTo(h264);
  });
});
