// SPDX-License-Identifier: AGPL-3.0-only
import type { RoomSettings } from '@openlive/protocol';
import { AUDIO_KBPS, LOW_LAYER, MIDDLE_LAYER, QUALITY_PRESETS } from '@openlive/usage';
import { describe, expect, it } from 'vitest';
import {
  browserEncodings,
  browserPresets,
  defaultBrowserPreset,
  presetFrameRate,
} from '../src/golive/browser-encodings.ts';
import { canStreamFromBrowser, h264First } from '../src/golive/browser-live.ts';
import {
  browserOffers,
  goLiveChoice,
  helperFit,
  HELPER_PROTOCOL_MINOR,
  showHelperNudge,
} from '../src/golive/state.ts';

// Streaming from the browser: what the Go live panel leads with, and what the tab sends.

const SETTINGS: RoomSettings = {
  maxStreams: 4,
  maxViewersPerStream: 6,
  maxBitrateKbps: 0,
  allowedPresets: ['text', 'game', 'max', 'native', 'game120'],
};

describe('choice', () => {
  it('keeps the helper flow when one is online, with the browser as a link', () => {
    expect(goLiveChoice({ helpers: 1, displayMedia: true, os: 'linux' })).toEqual({
      kind: 'helper',
      browser: true,
    });
    expect(goLiveChoice({ helpers: 2, displayMedia: true, os: 'windows' })).toEqual({
      kind: 'helper',
      browser: true,
    });
  });

  it('leads with installing the helper when none is online; no download on Windows', () => {
    expect(goLiveChoice({ helpers: 0, displayMedia: true, os: 'macos' })).toEqual({
      kind: 'install',
      browser: true,
      download: true,
    });
    expect(goLiveChoice({ helpers: 0, displayMedia: true, os: 'windows' })).toEqual({
      kind: 'install',
      browser: true,
      download: false,
    });
  });

  it('hides the browser option where the browser cannot capture a screen', () => {
    expect(goLiveChoice({ helpers: 0, displayMedia: false, os: undefined })).toMatchObject({
      browser: false,
    });
    expect(goLiveChoice({ helpers: 1, displayMedia: false, os: 'linux' })).toMatchObject({
      browser: false,
    });
    expect(canStreamFromBrowser({ mediaDevices: {} } as Navigator)).toBe(false);
    expect(
      canStreamFromBrowser({
        mediaDevices: { getDisplayMedia: () => undefined },
      } as unknown as Navigator),
    ).toBe(true);
    expect(canStreamFromBrowser(undefined)).toBe(false);
  });

  it('nudges to install the helper after a browser stream, not on Windows or phones', () => {
    expect(showHelperNudge(true, 'linux')).toBe(true);
    expect(showHelperNudge(true, 'macos')).toBe(true);
    expect(showHelperNudge(true, 'windows')).toBe(false);
    expect(showHelperNudge(true, undefined)).toBe(false);
    expect(showHelperNudge(false, 'linux')).toBe(false);
  });

  it('offers 1080p30 and 1080p60 only, greyed out where the room forbids them', () => {
    expect(browserPresets(SETTINGS)).toEqual(['text', 'game']);
    expect(browserOffers(SETTINGS)).toEqual([
      { preset: 'text', allowed: true },
      { preset: 'game', allowed: true },
    ]);
    const textOnly = { ...SETTINGS, allowedPresets: ['text' as const] };
    expect(browserOffers(textOnly)).toEqual([
      { preset: 'text', allowed: true },
      { preset: 'game', allowed: false },
    ]);
    expect(defaultBrowserPreset(SETTINGS)).toBe('game');
    expect(defaultBrowserPreset(textOnly)).toBe('text');
    expect(defaultBrowserPreset({ ...SETTINGS, allowedPresets: ['max'] })).toBeNull();
    expect(presetFrameRate('text')).toBe(30);
    expect(presetFrameRate('game')).toBe(60);
  });

  it('does not call a 1.21 helper outdated: 1.22 changes only the web and the Worker', () => {
    const pc = {
      deviceId: 'd_pc',
      name: 'PC',
      os: 'linux' as const,
      arch: 'amd64' as const,
      helperVersion: '0.1.7',
      protocol: { major: 1, minor: 21 },
    };
    expect(HELPER_PROTOCOL_MINOR).toBe(21);
    expect(helperFit(pc, undefined, 'rm_1')).toBe('ready');
    expect(helperFit({ ...pc, protocol: { major: 1, minor: 20 } }, undefined, 'rm_1')).toBe(
      'outdated',
    );
  });
});

describe('encodings', () => {
  it("sends the helper's three layers for a 1080p source, highest first", () => {
    const plan = browserEncodings({
      preset: 'game',
      captured: { width: 1920, height: 1080, frameRate: 60 },
      audio: true,
      roomCapKbps: 0,
    });
    expect(plan.encodings).toEqual([
      { rid: 'f', active: true, maxBitrate: 8_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 },
      {
        rid: 'h',
        active: true,
        maxBitrate: MIDDLE_LAYER.kbps * 1000,
        maxFramerate: 60,
        scaleResolutionDownBy: 1.5,
      },
      {
        rid: 'q',
        active: true,
        maxBitrate: LOW_LAYER.kbps * 1000,
        maxFramerate: 30,
        scaleResolutionDownBy: 1080 / 480,
      },
    ]);
    expect(plan.layers).toEqual([
      { rid: 'f', width: 1920, height: 1080, fps: 60, kbps: 8000 },
      { rid: 'h', width: 1280, height: 720, fps: 60, kbps: MIDDLE_LAYER.kbps },
      { rid: 'q', width: 854, height: 480, fps: 30, kbps: LOW_LAYER.kbps },
    ]);
    expect(plan.maxBitrateKbps).toBe(
      QUALITY_PRESETS.game.kbps + MIDDLE_LAYER.kbps + LOW_LAYER.kbps + AUDIO_KBPS,
    );
  });

  it('keeps the middle layer no faster than the top one (1080p30)', () => {
    const plan = browserEncodings({
      preset: 'text',
      captured: { width: 1920, height: 1080, frameRate: 30 },
      audio: false,
      roomCapKbps: 0,
    });
    expect(plan.layers.map((l) => l.fps)).toEqual([30, 30, 30]);
    expect(plan.layers[0]?.kbps).toBe(QUALITY_PRESETS.text.kbps);
    expect(plan.maxBitrateKbps).toBe(
      QUALITY_PRESETS.text.kbps + MIDDLE_LAYER.kbps + LOW_LAYER.kbps,
    );
  });

  it("fits the source's aspect ratio and never scales a small one up", () => {
    // An ultrawide screen, captured at 1920 wide.
    const wide = browserEncodings({
      preset: 'game',
      captured: { width: 1920, height: 804, frameRate: 60 },
      audio: false,
      roomCapKbps: 0,
    });
    expect(wide.layers.map((l) => [l.width, l.height])).toEqual([
      [1920, 804],
      [1280, 536],
      [854, 358],
    ]);
    // A small window: the top layer is its own size.
    const small = browserEncodings({
      preset: 'game',
      captured: { width: 1000, height: 600, frameRate: 60 },
      audio: false,
      roomCapKbps: 0,
    });
    expect(small.encodings.map((e) => e.scaleResolutionDownBy)).toEqual([1, 1, 1.25]);
    expect(small.layers[0]).toMatchObject({ width: 1000, height: 600 });
  });

  it('caps the frame rate at what the capture delivers, and falls back to the preset size', () => {
    const plan = browserEncodings({
      preset: 'game',
      captured: { frameRate: 24 },
      audio: false,
      roomCapKbps: 0,
    });
    expect(plan.layers.map((l) => l.fps)).toEqual([24, 24, 24]);
    expect(plan.layers[0]).toMatchObject({ width: 1920, height: 1080 });
  });

  it("cuts the top layer to fit the room's bitrate cap, like the helper", () => {
    const plan = browserEncodings({
      preset: 'game',
      captured: { width: 1920, height: 1080, frameRate: 60 },
      audio: true,
      roomCapKbps: 9000,
    });
    const full = QUALITY_PRESETS.game.kbps + MIDDLE_LAYER.kbps + LOW_LAYER.kbps + AUDIO_KBPS;
    expect(plan.layers[0]?.kbps).toBe(QUALITY_PRESETS.game.kbps - (full - 9000));
    expect(plan.layers.slice(1).map((l) => l.kbps)).toEqual([MIDDLE_LAYER.kbps, LOW_LAYER.kbps]);
    expect(plan.maxBitrateKbps).toBe(9000);
    expect(plan.encodings[0]?.maxBitrate).toBe((plan.layers[0]?.kbps ?? 0) * 1000);
  });

  it('lowers every layer under economy mode, audio included', () => {
    const plan = browserEncodings({
      preset: 'game',
      captured: { width: 1920, height: 1080, frameRate: 60 },
      audio: true,
      roomCapKbps: 0,
      qualityCap: { maxHeight: 1080, maxBitrateKbps: 3000 },
    });
    expect(plan.layers.map((l) => l.kbps)).toEqual([3000 - AUDIO_KBPS, 3000 - AUDIO_KBPS, 1000]);
    // A lower height cap shrinks the layers that are taller.
    const short = browserEncodings({
      preset: 'game',
      captured: { width: 1920, height: 1080, frameRate: 60 },
      audio: false,
      roomCapKbps: 0,
      qualityCap: { maxHeight: 720, maxBitrateKbps: 8000 },
    });
    expect(short.layers.map((l) => l.height)).toEqual([720, 720, 480]);
  });
});

describe('codecs', () => {
  it('puts H.264 first and keeps the rest in order', () => {
    const codecs = [
      { mimeType: 'video/VP8' },
      { mimeType: 'video/H264', sdpFmtpLine: 'a' },
      { mimeType: 'video/rtx' },
      { mimeType: 'video/H264', sdpFmtpLine: 'b' },
    ];
    expect(h264First(codecs).map((c) => c.mimeType)).toEqual([
      'video/H264',
      'video/H264',
      'video/VP8',
      'video/rtx',
    ]);
  });
});
