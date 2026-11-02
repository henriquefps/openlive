// SPDX-License-Identifier: AGPL-3.0-only
import type { Rid } from './source.ts';
import type { StatsSample } from './stats.ts';

// The "Automatic" quality setting, decided in the viewer: start on the high layer, go
// one layer down after a sustained bad stretch (loss, freezes, frames the network or the decoder
// cannot keep up with, frames the decoder drops), go one layer up after a stable stretch. Dropped
// frames are what a phone shows when it cannot decode a 120 fps layer: no
// loss, a decode time within budget, but a share of the frames never shown. Each failed climb (a step down soon
// after a step up) doubles the stable stretch needed before the next one, so a viewer on the edge
// does not bounce between layers; a climb that holds resets it. Pure: the player feeds it one
// stats sample per second.

export interface AutoOptions {
  /** Bad samples for this long → one layer down. */
  downAfterMs: number;
  /** Good samples for this long → one layer up (the base, before backoff). */
  upAfterMs: number;
  /** Ceiling of the doubled stable stretch. */
  maxUpAfterMs: number;
  /** A step down this soon after a step up counts as a failed climb. */
  failedClimbMs: number;
  /** No switch this soon after the previous one: the new layer's stats need to settle. */
  settleMs: number;
  /** Loss at or above this (0–1) is bad; at or below `lossGood` is good. */
  lossBad: number;
  lossGood: number;
  /** fps below this share of the layer's nominal fps is bad when packets are lost too. */
  fpsFloor: number;
  /** Mean decode time above this share of the frame interval is bad (the decoder falls behind). */
  decodeBudget: number;
  /** Dropped frames at or above this share of the frames (0–1) are bad; good needs below `dropGood`. */
  dropBad: number;
  dropGood: number;
  /** Fewer dropped frames than this in a sample are noise (a keyframe's hiccup). */
  dropMinFrames: number;
}

export const AUTO_DEFAULTS: AutoOptions = {
  downAfterMs: 3_000,
  upAfterMs: 10_000,
  maxUpAfterMs: 120_000,
  failedClimbMs: 20_000,
  settleMs: 4_000,
  lossBad: 0.05,
  lossGood: 0.01,
  fpsFloor: 0.6,
  decodeBudget: 0.8,
  dropBad: 0.1,
  dropGood: 0.02,
  dropMinFrames: 3,
};

/** The share of the sample's frames the decoder dropped (dropped over decoded plus dropped). */
export function dropShare(sample: StatsSample): number {
  const total = sample.newFramesDecoded + sample.newFramesDropped;
  return total > 0 ? sample.newFramesDropped / total : 0;
}

export interface AutoState {
  layer: Rid;
  /** Start of the current bad or good stretch; null when the last sample was neither. */
  badSince: number | null;
  goodSince: number | null;
  lastSwitchAt: number;
  lastClimbAt: number | null;
  upAfterMs: number;
}

export interface AutoContext {
  /** Layers on offer, highest first. */
  layers: readonly Rid[];
  /** Nominal fps of the current layer, when known. */
  nominalFps: number | null;
}

export function initialAuto(
  layer: Rid,
  now: number,
  options: AutoOptions = AUTO_DEFAULTS,
): AutoState {
  return {
    layer,
    badSince: null,
    goodSince: null,
    lastSwitchAt: now,
    lastClimbAt: null,
    upAfterMs: options.upAfterMs,
  };
}

export type Verdict = 'bad' | 'good' | 'neutral';

export function judge(
  sample: StatsSample,
  nominalFps: number | null,
  options: AutoOptions = AUTO_DEFAULTS,
): Verdict {
  // The first sample after a pull or a switch has no rates yet.
  if (sample.fps === null || sample.loss === null) return 'neutral';
  if (sample.newFreezes > 0 || sample.loss >= options.lossBad) return 'bad';
  // Screen content is often static and the encoder sends fewer frames then, so low fps alone is
  // not a network problem. Low fps with loss is; a decoder slower than the frame rate always is.
  const lowFps = nominalFps !== null && sample.fps < nominalFps * options.fpsFloor;
  if (lowFps && sample.loss > options.lossGood) return 'bad';
  if (nominalFps !== null && sample.decodeMs !== null) {
    if (sample.decodeMs > (1000 / nominalFps) * options.decodeBudget) return 'bad';
  }
  const dropped = dropShare(sample);
  if (sample.newFramesDropped >= options.dropMinFrames && dropped >= options.dropBad) return 'bad';
  return sample.loss <= options.lossGood && dropped < options.dropGood ? 'good' : 'neutral';
}

/** One sample in, the next state out; `state.layer` changes when the policy switches. */
export function stepAuto(
  state: AutoState,
  sample: StatsSample,
  context: AutoContext,
  options: AutoOptions = AUTO_DEFAULTS,
): AutoState {
  const now = sample.at;
  const verdict = judge(sample, context.nominalFps, options);
  const next: AutoState = {
    ...state,
    badSince: verdict === 'bad' ? (state.badSince ?? now) : null,
    goodSince: verdict === 'good' ? (state.goodSince ?? now) : null,
  };
  // A climb that held long enough: back to the base stable stretch.
  if (next.lastClimbAt !== null && now - next.lastClimbAt >= options.failedClimbMs) {
    next.lastClimbAt = null;
    next.upAfterMs = options.upAfterMs;
  }
  if (now - state.lastSwitchAt < options.settleMs) return next;

  const index = context.layers.indexOf(state.layer);
  if (index === -1) return next;
  if (next.badSince !== null && now - next.badSince >= options.downAfterMs) {
    const lower = context.layers[index + 1];
    if (!lower) return next;
    const failedClimb = next.lastClimbAt !== null;
    return {
      layer: lower,
      badSince: null,
      goodSince: null,
      lastSwitchAt: now,
      lastClimbAt: null,
      upAfterMs: failedClimb ? Math.min(options.maxUpAfterMs, next.upAfterMs * 2) : next.upAfterMs,
    };
  }
  if (next.goodSince !== null && now - next.goodSince >= next.upAfterMs) {
    const higher = index > 0 ? context.layers[index - 1] : undefined;
    if (!higher) return next;
    return {
      ...next,
      layer: higher,
      badSince: null,
      goodSince: null,
      lastSwitchAt: now,
      lastClimbAt: now,
    };
  }
  return next;
}

/**
 * Where Automatic starts: the high layer, or the middle one on a cellular connection
 * and in economy mode (callers pass `true` for both).
 */
export function startLayer(layers: readonly Rid[], cellular: boolean): Rid | null {
  if (layers.length === 0) return null;
  if (cellular && layers.length > 1) return layers[1] ?? null;
  return layers[0] ?? null;
}
