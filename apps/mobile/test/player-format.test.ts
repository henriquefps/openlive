// SPDX-License-Identifier: AGPL-3.0-only
import type { Layer, StatsSample } from '@openlive/client';
import { describe, expect, it } from 'vitest';
import { layerLabel, qualityOptions, statsLines } from '../src/player/format.ts';
import { playerTexts } from '../src/player/locales.ts';
import { clampVolume, DEFAULT_VOLUME, effectiveVolume, stepVolume } from '../src/player/volume.ts';

const LAYERS: Layer[] = [
  { rid: 'f', height: 1440, fps: 120 },
  { rid: 'h', height: 720, fps: 60 },
  { rid: 'q', height: 480, fps: 30 },
];

describe('quality menu', () => {
  it('lists Automatic first, then the layers highest first', () => {
    expect(qualityOptions(LAYERS)).toEqual([
      { value: 'auto', label: null },
      { value: 'f', label: '1440p120' },
      { value: 'h', label: '720p60' },
      { value: 'q', label: '480p30' },
    ]);
  });

  it('has no menu for a stream with one layer or none', () => {
    expect(qualityOptions([])).toEqual([]);
    expect(qualityOptions(LAYERS.slice(0, 1))).toEqual([]);
  });

  it('names a layer by height and rounded frame rate', () => {
    expect(layerLabel({ height: 1080, fps: 59.94 })).toBe('1080p60');
  });
});

describe('stats lines', () => {
  const sample = {
    width: 1920,
    height: 1080,
    fps: 59.6,
    bitrateBps: 8_400_000,
    loss: 0.012,
    jitterBufferMs: 41.2,
    rttMs: 23.4,
    codec: 'H264',
    decodeMs: 3.14,
  } as StatsSample;

  it('shows what the sample has, in order, with the AV1/H.264 codec in capitals', () => {
    const lines = statsLines(sample, { layer: '1080p60', ttffMs: 640, codec: 'av1' });
    expect(lines.map((l) => `${l.key}=${l.value}`)).toEqual([
      'resolution=1920×1080',
      'fps=60',
      'bitrate=8.4 Mbps',
      'loss=1.2 %',
      'jitterBuffer=41 ms',
      'rtt=23 ms',
      'codec=AV1',
      'layer=1080p60',
      'decode=3.1 ms',
      'ttff=640 ms',
    ]);
  });

  it('shows nothing before the first sample', () => {
    expect(statsLines(null, { layer: null, ttffMs: null, codec: null })).toEqual([]);
  });
});

describe('volume', () => {
  it('clamps and steps; turning up unmutes, turning down keeps the mute', () => {
    expect(clampVolume(2)).toBe(1);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(Number.NaN)).toBe(1);
    expect(stepVolume({ volume: 0.5, muted: true }, 1)).toEqual({ volume: 0.6, muted: false });
    expect(stepVolume({ volume: 0.5, muted: true }, -1)).toEqual({ volume: 0.4, muted: true });
    expect(stepVolume({ volume: 0, muted: false }, -1).volume).toBe(0);
  });

  it('is silent while muted', () => {
    expect(effectiveVolume(DEFAULT_VOLUME)).toBe(1);
    expect(effectiveVolume({ volume: 0.7, muted: true })).toBe(0);
  });
});

describe('player texts', () => {
  const keys = (value: unknown, prefix = ''): string[] =>
    typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
      : [prefix];

  it('have the same keys in English and Portuguese', () => {
    expect(keys(playerTexts['pt-BR']).sort()).toEqual(keys(playerTexts.en).sort());
  });

  it('carry every screen the state overlay can show', () => {
    const screens = playerTexts.en.player.screen as Record<string, unknown>;
    for (const key of [
      'connecting',
      'paused',
      'curtain',
      'reconnecting',
      'ended',
      'noPermission',
      'roomExpired',
      'helperOffline',
      'helperOutdated',
      'full',
    ]) {
      expect(screens[key], key).toBeDefined();
    }
  });
});
