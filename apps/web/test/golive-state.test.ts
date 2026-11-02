// SPDX-License-Identifier: AGPL-3.0-only
import type { HelperInfo, RoomSettings, SourceDescriptor } from '@openlive/protocol';
import { describe, expect, it } from 'vitest';
import {
  audioChoices,
  blockerOf,
  failureOf,
  frameRateOf,
  frameRateOptions,
  helperFit,
  INITIAL_WIZARD,
  knowsHighFrameRate,
  liveHere,
  offeredPresets,
  PRESET_ORDER,
  presetFor,
  presetForResolution,
  resolutionOf,
  resolutionOptions,
  roomCapKbps,
  startPayload,
  uploadNeededKbps,
  wizard,
  type WizardState,
} from '../src/golive/state.ts';

const PC: HelperInfo = {
  deviceId: 'd_pc',
  name: 'PC',
  os: 'linux',
  arch: 'amd64',
  helperVersion: '0.1.0',
  protocol: { major: 1, minor: 20 },
};
const SETTINGS: RoomSettings = {
  maxStreams: 4,
  maxViewersPerStream: 6,
  maxBitrateKbps: 13000,
  allowedPresets: ['text', 'game', 'max'],
};
const SOURCES: SourceDescriptor[] = [
  { sourceId: 'screen1', kind: 'screen', label: 'Screen 1', hasAudio: false },
  { sourceId: 'w_game', kind: 'window', label: 'Game', appName: 'game', hasAudio: true },
  { sourceId: 'w_term', kind: 'window', label: 'Terminal', hasAudio: false },
];

describe('presets and upload', () => {
  it('needs about 22 Mb/s of upload for 1440p60 with its layers', () => {
    expect(uploadNeededKbps('max', false)).toBe(21450);
    expect(uploadNeededKbps('game', true)).toBe(16416);
  });

  it('shows the room cap only when the preset would send more', () => {
    expect(roomCapKbps(SETTINGS, 'game', true)).toBeNull();
    expect(roomCapKbps(SETTINGS, 'max', false)).toBe(13000);
  });

  it('offers native only where the room allows it, and marks what is not allowed', () => {
    expect(offeredPresets(SETTINGS)).toEqual([
      { preset: 'text', allowed: true },
      { preset: 'game', allowed: true },
      { preset: 'max', allowed: true },
    ]);
    expect(offeredPresets({ ...SETTINGS, allowedPresets: ['text', 'native'] })).toEqual([
      { preset: 'text', allowed: true },
      { preset: 'game', allowed: false },
      { preset: 'max', allowed: false },
      { preset: 'native', allowed: true },
    ]);
  });

  it('offers the 120 fps presets only where the room allows them, to a helper that knows them', () => {
    const fast: RoomSettings = {
      ...SETTINGS,
      maxBitrateKbps: 25_000,
      allowedPresets: ['text', 'game', 'max', 'game120', 'max120'],
    };
    const names = (s: RoomSettings, h?: HelperInfo) => offeredPresets(s, h).map((o) => o.preset);
    expect(names(fast, PC)).toEqual(['text', 'game', 'max', 'game120', 'max120']);
    // Off by default: the room does not allow them.
    expect(names(SETTINGS, PC)).toEqual(['text', 'game', 'max']);
    // A helper from before protocol 1.8 would reject them.
    expect(names(fast, { ...PC, protocol: { major: 1, minor: 7 } })).toEqual([
      'text',
      'game',
      'max',
    ]);
    expect(names(fast)).toEqual(['text', 'game', 'max']);
    expect(knowsHighFrameRate({ protocol: { major: 2, minor: 0 } })).toBe(true);
  });

  it('needs upload for the top layer plus headroom', () => {
    expect(uploadNeededKbps('max120', true)).toBe(Math.round(24_628 * 1.3));
  });

  it('maps presets to a resolution and a frame rate, and back', () => {
    expect(PRESET_ORDER.map((p) => [p, resolutionOf(p), frameRateOf(p)])).toEqual([
      ['text', 1080, 30],
      ['game', 1080, 60],
      ['max', 1440, 60],
      ['native', 2160, 60],
      ['game120', 1080, 120],
      ['max120', 1440, 120],
    ]);
    for (const p of PRESET_ORDER) expect(presetFor(resolutionOf(p), frameRateOf(p))).toBe(p);
    expect(presetFor(1440, 30)).toBeNull();
    expect(presetFor(2160, 120)).toBeNull();
  });

  describe('resolution and frame rate selects', () => {
    const all: RoomSettings = {
      ...SETTINGS,
      allowedPresets: ['text', 'game', 'max', 'native', 'game120', 'max120'],
    };
    const offers = offeredPresets(all, PC);
    const fps = (res: number) => frameRateOptions(offers, res).map((o) => o.fps);

    it('lists only the frame rates a resolution has a preset for', () => {
      expect(resolutionOptions(offers).map((o) => o.resolution)).toEqual([1080, 1440, 2160]);
      expect(fps(1080)).toEqual([30, 60, 120]);
      expect(fps(1440)).toEqual([60, 120]);
      expect(fps(2160)).toEqual([60]);
    });

    it('keeps the frame rate when the new resolution has it, else the nearest, preferring 60', () => {
      expect(presetForResolution(offers, 'game120', 1440)).toBe('max120');
      expect(presetForResolution(offers, 'game', 1440)).toBe('max');
      expect(presetForResolution(offers, 'text', 1440)).toBe('max');
      expect(presetForResolution(offers, 'text', 2160)).toBe('native');
      expect(presetForResolution(offers, 'max120', 2160)).toBe('native');
      expect(presetForResolution(offers, 'max120', 1080)).toBe('game120');
    });

    it('skips presets the room does not allow, and resolutions with none', () => {
      const limited = offeredPresets({ ...all, allowedPresets: ['text', 'native'] }, PC);
      expect(resolutionOptions(limited)).toEqual([
        { resolution: 1080, allowed: true },
        { resolution: 1440, allowed: false },
        { resolution: 2160, allowed: true },
      ]);
      expect(presetForResolution(limited, 'text', 1440)).toBeNull();
      expect(presetForResolution(limited, 'text', 2160)).toBe('native');
      expect(frameRateOptions(limited, 1080).map((o) => [o.fps, o.allowed])).toEqual([
        [30, true],
        [60, false],
      ]);
    });

    it('hides 120 fps from a helper that does not know it', () => {
      const old = offeredPresets(all, { protocol: { major: 1, minor: 7 } });
      expect(frameRateOptions(old, 1080).map((o) => o.fps)).toEqual([30, 60]);
      expect(frameRateOptions(old, 1440).map((o) => o.fps)).toEqual([60]);
    });
  });
});

describe('helpers', () => {
  it('classifies ready, outdated, unsupported, busy and live here', () => {
    expect(helperFit(PC, undefined, 'rm_1')).toBe('ready');
    expect(helperFit({ ...PC, protocol: { major: 1, minor: 1 } }, undefined, 'rm_1')).toBe(
      'outdated',
    );
    expect(helperFit({ ...PC, protocol: { major: 2, minor: 0 } }, undefined, 'rm_1')).toBe(
      'unsupported',
    );
    const live = (roomId: string) => ({
      deviceId: 'd_pc',
      state: 'live' as const,
      stream: { roomId, sourceId: 's', preset: 'game' as const },
    });
    expect(helperFit(PC, live('rm_2'), 'rm_1')).toBe('busy');
    expect(helperFit(PC, live('rm_1'), 'rm_1')).toBe('live_here');
    expect(helperFit(PC, { deviceId: 'd_pc', state: 'error' }, 'rm_1')).toBe('ready');
    expect(liveHere({ d_pc: live('rm_1') }, 'rm_1')?.deviceId).toBe('d_pc');
    expect(liveHere({ d_pc: live('rm_2') }, 'rm_1')).toBeNull();
  });

  it('blocks without the permission, without the hub and without a helper', () => {
    expect(blockerOf({ canStream: false, hubOpen: true, helpers: [PC] })).toBe('no_permission');
    expect(blockerOf({ canStream: true, hubOpen: false, helpers: [] })).toBe('hub_down');
    expect(blockerOf({ canStream: true, hubOpen: true, helpers: [] })).toBe('no_helper');
    expect(blockerOf({ canStream: true, hubOpen: true, helpers: [PC] })).toBeNull();
  });

  it('gives quota, permission, busy and offline failures their own screen', () => {
    expect(failureOf({ code: 'quota_exhausted' })).toBe('quota');
    expect(failureOf({ code: 'stream_permission_required', roomId: 'rm_1' })).toBe('no_permission');
    expect(failureOf({ code: 'helper_busy', deviceId: 'd_pc' })).toBe('busy');
    expect(failureOf({ code: 'helper_offline', deviceId: 'd_pc' })).toBe('offline');
    expect(failureOf({ code: 'sfu_error' })).toBe('other');
  });
});

describe('audio', () => {
  it('offers a window its own sound, and a screen the sound of an app', () => {
    expect(audioChoices(SOURCES, 'w_game')).toEqual([{ kind: 'none' }, { kind: 'source' }]);
    expect(audioChoices(SOURCES, 'w_term')).toEqual([{ kind: 'none' }]);
    expect(audioChoices(SOURCES, 'screen1')).toEqual([
      { kind: 'none' },
      { kind: 'app', sourceId: 'w_game' },
    ]);
  });
});

describe('wizard', () => {
  const run = (...actions: Parameters<typeof wizard>[1][]): WizardState =>
    actions.reduce(wizard, INITIAL_WIZARD);

  it('goes helper → source → options → starting and builds the start payload', () => {
    const s = run(
      { type: 'chooseHelper', deviceId: 'd_pc' },
      { type: 'sourcesLoaded', sources: SOURCES },
      { type: 'chooseSource', sourceId: 'screen1', preset: 'game' },
      { type: 'chooseAudio', audio: { kind: 'app', sourceId: 'w_game' } },
      { type: 'choosePreset', preset: 'max' },
    );
    expect(s.step).toBe('options');
    expect(startPayload(s, 'rm_1')).toEqual({
      deviceId: 'd_pc',
      roomId: 'rm_1',
      sourceId: 'screen1',
      preset: 'max',
      audio: true,
      audioSourceId: 'w_game',
    });
    expect(wizard(s, { type: 'start' }).step).toBe('starting');
  });

  it('defaults a window to its own sound and a screen to none', () => {
    const loaded = run(
      { type: 'chooseHelper', deviceId: 'd_pc' },
      { type: 'sourcesLoaded', sources: SOURCES },
    );
    expect(
      wizard(loaded, { type: 'chooseSource', sourceId: 'w_game', preset: 'game' }).audio,
    ).toEqual({
      kind: 'source',
    });
    expect(
      wizard(loaded, { type: 'chooseSource', sourceId: 'screen1', preset: 'game' }).audio,
    ).toEqual({ kind: 'none' });
  });

  it('goes back to the options with the error after a failed start, and back step by step', () => {
    let s = run(
      { type: 'chooseHelper', deviceId: 'd_pc' },
      { type: 'sourcesLoaded', sources: SOURCES },
      { type: 'chooseSource', sourceId: 'w_game', preset: 'game' },
      { type: 'start' },
      { type: 'failed', error: { code: 'quota_exhausted' } },
    );
    expect(s).toMatchObject({ step: 'options', error: { code: 'quota_exhausted' } });
    s = wizard(s, { type: 'back' });
    expect(s).toMatchObject({ step: 'source', error: null });
    expect(wizard(s, { type: 'back' })).toEqual(INITIAL_WIZARD);
  });

  it('does not start without a preset', () => {
    const s = run(
      { type: 'chooseHelper', deviceId: 'd_pc' },
      { type: 'sourcesLoaded', sources: SOURCES },
      { type: 'chooseSource', sourceId: 'w_game', preset: null },
      { type: 'start' },
    );
    expect(s.step).toBe('options');
  });
});
