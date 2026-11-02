// SPDX-License-Identifier: AGPL-3.0-only
import { egressGB, type Overheads } from './calculator.js';

// The helper's quality presets (helper/internal/media/presets.go): the top simulcast layer of each, the two fixed lower layers and the audio.
// The web's preset picker, its upload estimate and the per-viewer cost read them from here, so
// they agree with what the helper sends.

export interface PresetLayer {
  width: number;
  height: number;
  fps: number;
  kbps: number;
}

/** The top layer of each preset, keyed by the protocol's `Preset` values. */
export const QUALITY_PRESETS = {
  text: { width: 1920, height: 1080, fps: 30, kbps: 6000 },
  game: { width: 1920, height: 1080, fps: 60, kbps: 8000 },
  max: { width: 2560, height: 1440, fps: 60, kbps: 12000 },
  native: { width: 3840, height: 2160, fps: 60, kbps: 25000 },
  game120: { width: 1920, height: 1080, fps: 120, kbps: 14000 },
  max120: { width: 2560, height: 1440, fps: 120, kbps: 20000 },
} as const satisfies Record<string, PresetLayer>;

export type QualityPreset = keyof typeof QUALITY_PRESETS;

/** The order presets are offered in: the 60 fps ones, lowest first, then the 120 fps ones. */
export const QUALITY_PRESET_ORDER: readonly QualityPreset[] = [
  'text',
  'game',
  'max',
  'native',
  'game120',
  'max120',
];

/** The middle and low simulcast layers every preset sends; only the top one runs at 120 fps. */
export const MIDDLE_LAYER: PresetLayer = { width: 1280, height: 720, fps: 60, kbps: 3500 };
export const LOW_LAYER: PresetLayer = { width: 854, height: 480, fps: 30, kbps: 1000 };
/** Opus, as the helper sends it. */
export const AUDIO_KBPS = 128;
/** A voice microphone (Opus): each listener receives this much. */
export const VOICE_KBPS = 32;

/**
 * A camera in the voice channel: two simulcast layers, highest
 * first. The strip pulls the low one, an enlarged camera the high one; the web publishes exactly
 * these and the meter charges each pull at its layer's rate.
 */
export const CAMERA_LAYERS = {
  h: { width: 640, height: 360, fps: 30, kbps: 500 },
  l: { width: 320, height: 180, fps: 30, kbps: 150 },
} as const satisfies Record<string, PresetLayer>;

export type CameraRid = keyof typeof CAMERA_LAYERS;

/** What one viewer receives of a camera on `rid`; the high layer for an unknown or absent one. */
export function cameraLayerKbps(rid: string | null): number {
  return rid === 'l' ? CAMERA_LAYERS.l.kbps : CAMERA_LAYERS.h.kbps;
}

/** Most cameras on at once in a room, by default. */
export const DEFAULT_MAX_CAMERAS = 6;

/** Whether a preset runs faster than 60 fps (off by default). */
export const isHighFrameRate = (preset: QualityPreset): boolean => QUALITY_PRESETS[preset].fps > 60;

/** What the helper publishes for a preset: every layer, plus the audio. */
export function presetSendKbps(preset: QualityPreset, audio: boolean): number {
  return (
    QUALITY_PRESETS[preset].kbps + MIDDLE_LAYER.kbps + LOW_LAYER.kbps + (audio ? AUDIO_KBPS : 0)
  );
}

/**
 * The highest bitrate any preset sends in full (every layer and the audio), rounded up to a whole
 * Mbps: the ceiling of the platform's `maxBitrateKbps`, so every allowed preset can run uncapped.
 */
export const MAX_PRESET_SEND_KBPS =
  Math.ceil(Math.max(...QUALITY_PRESET_ORDER.map((p) => presetSendKbps(p, true))) / 1000) * 1000;

/**
 * The top layer's bitrate once the room's cap (`maxBitrateKbps`, which covers every layer and the
 * audio) is applied, as the helper's fitRoom does: the top layer absorbs the cut.
 */
export function cappedTopKbps(preset: QualityPreset, audio: boolean, capKbps: number): number {
  const top = QUALITY_PRESETS[preset].kbps;
  if (capKbps <= 0) return top;
  return Math.max(0, Math.min(top, top - (presetSendKbps(preset, audio) - capKbps)));
}

/** Billed GB one viewer of the top layer costs per hour (one join), with the calculator's formula. */
export function viewerHourGB(preset: QualityPreset, o: Overheads, capKbps = 0): number {
  return egressGB(
    { bitrateMbps: cappedTopKbps(preset, true, capKbps) / 1000, viewerSeconds: 3600, joins: 1 },
    o,
  );
}

/**
 * A video codec a viewer pulls (protocol `VideoCodec`, since 1.14). Every stream has H.264; with
 * AV1 allowed it also publishes its top layer in AV1.
 */
export type VideoCodec = 'h264' | 'av1';

/**
 * How a preset's AV1 track spends its bits: `save` sends less than
 * H.264 for a similar picture, `quality` as much as H.264 for a sharper one (high motion above all).
 */
export type Av1Mode = 'save' | 'quality';

/**
 * An AV1 layer's bitrate as a percent of the H.264 layer it mirrors, per mode
 * (helper/internal/media/av1.go, AV1SavePercent and AV1QualityPercent). `save` is an assumption
 * until it is measured on real content (F3).
 */
export const AV1_MODE_PERCENT = { save: 65, quality: 100 } as const satisfies Record<
  Av1Mode,
  number
>;

/**
 * A preset's codec choice, set by the platform admin with AV1 allowed (protocol 1.17): AV1 for the
 * viewers that decode it, saving data or for quality, or H.264 only. Before 1.17 the choice was
 * `auto`, which is `av1Save`.
 */
export const PRESET_CODECS = ['av1Save', 'av1Quality', 'h264'] as const;
export type PresetCodec = (typeof PRESET_CODECS)[number];

/** A preset's AV1 mode under a codec choice; null for H.264 only. */
export function av1ModeOf(choice: PresetCodec): Av1Mode | null {
  return choice === 'av1Save' ? 'save' : choice === 'av1Quality' ? 'quality' : null;
}

/** What a viewer receives of a layer of `kbps` (as H.264) when it pulls `codec`, AV1 in `mode`. */
export function codecKbps(
  kbps: number,
  codec: VideoCodec | null | undefined,
  mode: Av1Mode = 'save',
): number {
  return codec === 'av1' ? (kbps * AV1_MODE_PERCENT[mode]) / 100 : kbps;
}

/**
 * The top-layer bitrate one viewer of `preset` receives under a codec choice, the room's cap
 * applied: an AV1 viewer's on the AV1 choices (a viewer without AV1 gets the H.264 rate,
 * `cappedTopKbps`). The cost calculator's per-viewer bitrate.
 */
export function presetViewerKbps(preset: QualityPreset, choice: PresetCodec, capKbps = 0): number {
  const mode = av1ModeOf(choice);
  const top = cappedTopKbps(preset, true, capKbps);
  return mode ? codecKbps(top, 'av1', mode) : top;
}

/**
 * Billed GB one viewer of the top layer costs per hour on `codec`: viewerHourGB at the AV1
 * track's bitrate in `mode` (the H.264 track's otherwise).
 */
export function viewerHourGBFor(
  preset: QualityPreset,
  codec: VideoCodec,
  o: Overheads,
  capKbps = 0,
  mode: Av1Mode = 'save',
): number {
  return egressGB(
    {
      bitrateMbps: codecKbps(cappedTopKbps(preset, true, capKbps), codec, mode) / 1000,
      viewerSeconds: 3600,
      joins: 1,
    },
    o,
  );
}
