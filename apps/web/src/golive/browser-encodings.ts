// SPDX-License-Identifier: AGPL-3.0-only
import type { Preset, QualityCap, RoomSettings, VideoLayer } from '@openlive/protocol';
import { AUDIO_KBPS, BROWSER_PRESETS, simulcastLayers } from '@openlive/usage';

// What a browser stream sends (protocol 1.22, docs/PROTOCOL.md 11.2 "Publishing (browser)"): the
// helper's three simulcast layers f/h/q from @openlive/usage, fitted to the captured size, the
// room's bitrate cap (the top layer absorbs the cut, like the helper's fitRoom) and economy mode
// (every layer at most the cap's bitrate, audio included, like the helper's capLayers).

/** One `sendEncodings` entry, in the browser's units (bits per second). */
export interface BrowserEncoding {
  rid: string;
  active: true;
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
}

export interface BrowserEncodingPlan {
  /** For `addTransceiver(track, { sendEncodings })` and later `setParameters`. */
  encodings: BrowserEncoding[];
  /** What `stream.announce` reports: the layers as encoded (since 1.19). */
  layers: VideoLayer[];
  /** The publish's `maxBitrateKbps`: every layer and the audio, at most the room's cap. */
  maxBitrateKbps: number;
}

export interface BrowserEncodingInput {
  preset: Preset;
  /** The captured track's size and frame rate (`getSettings()`); the preset's when unknown. */
  captured: {
    width?: number | undefined;
    height?: number | undefined;
    frameRate?: number | undefined;
  };
  audio: boolean;
  /** The room's `maxBitrateKbps` (0 or less: no cap). */
  roomCapKbps: number;
  /** Economy mode, from the publish answer or `stream.updated`. */
  qualityCap?: QualityCap | null | undefined;
}

/** Even, at least 2: encoders want even sizes. */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function browserEncodings(input: BrowserEncodingInput): BrowserEncodingPlan {
  const layers = simulcastLayers(input.preset);
  const top = layers[0];
  if (!top) throw new Error('a preset has a top layer');
  const width = input.captured.width && input.captured.width > 0 ? input.captured.width : top.width;
  const height =
    input.captured.height && input.captured.height > 0 ? input.captured.height : top.height;
  const capturedFps =
    input.captured.frameRate && input.captured.frameRate > 0 ? input.captured.frameRate : top.fps;
  const cap = input.qualityCap ?? null;
  const audioKbps = input.audio ? AUDIO_KBPS : 0;
  const fitted = layers.map((l) => {
    const boxHeight = cap ? Math.min(l.height, cap.maxHeight) : l.height;
    const boxWidth = Math.round((l.width * boxHeight) / l.height);
    // Fit inside the layer's box, keeping the source's aspect ratio; never scale up.
    const scale = Math.max(1, width / boxWidth, height / boxHeight);
    const kbps = cap ? Math.max(1, Math.min(l.kbps, cap.maxBitrateKbps - audioKbps)) : l.kbps;
    return {
      rid: l.rid,
      width: even(width / scale),
      height: even(height / scale),
      fps: Math.max(1, Math.min(l.fps, Math.round(capturedFps))),
      kbps,
      scale,
    };
  });
  const total = fitted.reduce((sum, l) => sum + l.kbps, 0) + audioKbps;
  const over = input.roomCapKbps > 0 ? total - input.roomCapKbps : 0;
  const first = fitted[0];
  if (first && over > 0) first.kbps = Math.max(1, first.kbps - over);
  return {
    encodings: fitted.map((l) => ({
      rid: l.rid,
      active: true,
      maxBitrate: l.kbps * 1000,
      maxFramerate: l.fps,
      scaleResolutionDownBy: l.scale,
    })),
    layers: fitted.map(({ rid, width: w, height: h, fps, kbps }) => ({
      rid,
      width: w,
      height: h,
      fps,
      kbps,
    })),
    maxBitrateKbps: over > 0 ? input.roomCapKbps : total,
  };
}

/** The presets a browser may stream with in this room, lowest first: at most 1080p60. */
export function browserPresets(settings: RoomSettings): Preset[] {
  return BROWSER_PRESETS.filter((p) => settings.allowedPresets.includes(p));
}

/** The default browser preset: 1080p60 where allowed, else 1080p30; null when neither is. */
export function defaultBrowserPreset(settings: RoomSettings): Preset | null {
  const offered = browserPresets(settings);
  return offered.includes('game') ? 'game' : (offered[0] ?? null);
}

/** The frame rate to ask `getDisplayMedia` for. */
export const presetFrameRate = (preset: Preset): number => simulcastLayers(preset)[0]?.fps ?? 30;
