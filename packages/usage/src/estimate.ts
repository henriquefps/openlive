// SPDX-License-Identifier: AGPL-3.0-only
// The /admin/settings estimate: a month of one group, from the settings being edited (not the saved
// ones) and a scenario the admin plays with. Built on the meter's formula (calculator.ts) and the
// presets' bitrates (presets.ts), so it agrees with what the month's meter will count.

import { ECONOMY_CAP } from './brakes.js';
import {
  cameraHourGB,
  costAboveFreeTier,
  egressGB,
  FREE_TIER_GB,
  type Overheads,
} from './calculator.js';
import {
  av1ModeOf,
  CAMERA_LAYERS,
  cappedTopKbps,
  MIDDLE_LAYER,
  type PresetCodec,
  presetViewerKbps,
  type QualityPreset,
  VOICE_KBPS,
} from './presets.js';

const SECONDS_PER_HOUR = 3600;

/** What the estimate reads from the settings form. */
export interface EstimateSettings {
  /** The presets the resolution and fps ceiling allow, lowest first. */
  presets: readonly QualityPreset[];
  /** The room's bitrate cap in kbps (every layer and the audio); 0 for none. */
  maxBitrateKbps: number;
  maxViewersPerStream: number;
  maxStreamsPerRoom: number;
  maxCamerasPerRoom: number;
  allowAv1: boolean;
  /** Per preset, with AV1 allowed; absent means `av1Save`. */
  presetCodecs: Partial<Record<QualityPreset, PresetCodec>>;
  /** The room capabilities the platform allows. */
  capabilities: { stream: boolean; voice: boolean; camera: boolean };
  overheads: Overheads;
  /** The monthly limit in GB, null when unlimited. */
  limitGB: number | null;
  /** Brake 3: economy mode above 90 % of the limit. */
  autoEconomy: boolean;
}

/** One month of a group, as the admin types it. */
export interface EstimateScenario {
  /** Friends watching each stream. */
  viewers: number;
  /** People streaming at the same time. */
  streamers: number;
  hoursPerDay: number;
  daysPerMonth: number;
  preset: QualityPreset;
  /** Share (0–1) of viewers whose browser decodes AV1. */
  av1Share: number;
  /** People in the voice channel during those hours. */
  voicePeople: number;
  /** Cameras on in voice, seen on the strip's low layer. */
  cameras: number;
}

export const DEFAULT_AV1_SHARE = 0.7;

export const DEFAULT_SCENARIO: EstimateScenario = {
  viewers: 4,
  streamers: 1,
  hoursPerDay: 2,
  daysPerMonth: 20,
  preset: 'game',
  av1Share: DEFAULT_AV1_SHARE,
  voicePeople: 5,
  cameras: 0,
};

/** What the settings cut from the scenario, so the panel can say why a number is lower. */
export type EstimateClamp = 'viewers' | 'streamers' | 'cameras' | 'voice' | 'stream' | 'preset';

export interface EstimateBreakdown {
  streamsH264GB: number;
  streamsAv1GB: number;
  voiceGB: number;
  camerasGB: number;
}

export interface Estimate {
  /** The scenario after the settings' limits. */
  applied: EstimateScenario;
  clamped: EstimateClamp[];
  /** GB a month by source, at full quality. */
  breakdown: EstimateBreakdown;
  totalGB: number;
  gbAboveFree: number;
  costUsd: number;
  /** The limit compared against; null when unlimited. */
  limitGB: number | null;
  /** Whether the month fits the limit (always true when unlimited). */
  fits: boolean;
  /** How many hours a day of this scenario fit the limit (the free tier when unlimited). */
  hoursPerDayThatFit: number;
  /**
   * Economy mode (brake 3) past 90 % of the limit: streams drop to the middle layer for the rest
   * of the month. Null when it would not engage.
   */
  economy: { startsAtGB: number; totalGB: number } | null;
  /** The top-layer bitrates one viewer receives, in kbps. */
  viewerKbps: { h264: number; av1: number | null };
}

const count = (n: number, max = Infinity) =>
  Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : 0;
const positive = (n: number, max = Infinity) =>
  Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;

/** The scenario's preset if the settings allow it, else the highest allowed one. */
function presetFor(s: EstimateSettings, wanted: QualityPreset): QualityPreset {
  if (s.presets.includes(wanted)) return wanted;
  return s.presets[s.presets.length - 1] ?? 'text';
}

/** The scenario after the settings' limits: what a room could actually do. */
export function applyLimits(
  settings: EstimateSettings,
  scenario: EstimateScenario,
): { applied: EstimateScenario; clamped: EstimateClamp[] } {
  const clamped: EstimateClamp[] = [];
  const cut = <T>(key: EstimateClamp, wanted: T, got: T): T => {
    if (wanted !== got) clamped.push(key);
    return got;
  };
  const { stream, voice, camera } = settings.capabilities;
  const viewers = count(scenario.viewers);
  const streamers = count(scenario.streamers);
  const voicePeople = count(scenario.voicePeople);
  const cameras = count(scenario.cameras);
  const applied: EstimateScenario = {
    viewers: stream
      ? cut('viewers', viewers, Math.min(viewers, settings.maxViewersPerStream))
      : viewers,
    streamers: stream
      ? cut('streamers', streamers, Math.min(streamers, settings.maxStreamsPerRoom))
      : cut('stream', streamers, 0),
    hoursPerDay: positive(scenario.hoursPerDay, 24),
    daysPerMonth: positive(scenario.daysPerMonth, 31),
    preset: cut('preset', scenario.preset, presetFor(settings, scenario.preset)),
    av1Share: positive(scenario.av1Share, 1),
    voicePeople: voice ? voicePeople : cut('voice', voicePeople, 0),
    cameras: 0,
  };
  const cameraCap = voice && camera ? Math.min(settings.maxCamerasPerRoom, applied.voicePeople) : 0;
  applied.cameras = cut('cameras', cameras, Math.min(cameras, cameraCap));
  return { applied, clamped };
}

/** GB of `pulls` viewer-hours at `kbps`, each pull joining once a day. */
const pullsGB = (kbps: number, pulls: number, hours: number, o: Overheads) =>
  egressGB(
    { bitrateMbps: kbps / 1000, viewerSeconds: pulls * hours * SECONDS_PER_HOUR, joins: pulls },
    o,
  );

/**
 * GB of one hour of a voice channel: every microphone is received by everyone else at VOICE_KBPS
 *, each pull joining once.
 */
export function voiceHourGB(people: number, o: Overheads): number {
  return pullsGB(VOICE_KBPS, people * Math.max(0, people - 1), 1, o);
}

/** A day of the applied scenario by source, given the viewer rates. */
function dailyBreakdown(
  a: EstimateScenario,
  rates: { h264: number; av1: number | null },
  o: Overheads,
): EstimateBreakdown {
  const pulls = a.streamers * a.viewers;
  const av1Pulls = rates.av1 === null ? 0 : pulls * a.av1Share;
  const h264Pulls = pulls - av1Pulls;
  return {
    streamsH264GB: h264Pulls > 0 ? pullsGB(rates.h264, h264Pulls, a.hoursPerDay, o) : 0,
    streamsAv1GB:
      av1Pulls > 0 && rates.av1 !== null ? pullsGB(rates.av1, av1Pulls, a.hoursPerDay, o) : 0,
    voiceGB: a.hoursPerDay * voiceHourGB(a.voicePeople, o),
    camerasGB:
      a.cameras > 0
        ? a.hoursPerDay *
          cameraHourGB(
            { cameras: a.cameras, people: a.voicePeople, cameraKbps: CAMERA_LAYERS.l.kbps },
            o,
          )
        : 0,
  };
}

const sum = (b: EstimateBreakdown) => b.streamsH264GB + b.streamsAv1GB + b.voiceGB + b.camerasGB;
const scale = (b: EstimateBreakdown, k: number): EstimateBreakdown => ({
  streamsH264GB: b.streamsH264GB * k,
  streamsAv1GB: b.streamsAv1GB * k,
  voiceGB: b.voiceGB * k,
  camerasGB: b.camerasGB * k,
});

/** The month of `scenario` under `settings`. */
export function estimateMonth(
  settings: EstimateSettings,
  scenario: EstimateScenario,
  freeGB = FREE_TIER_GB,
): Estimate {
  const { applied, clamped } = applyLimits(settings, scenario);
  const o = settings.overheads;
  const choice = settings.allowAv1 ? (settings.presetCodecs[applied.preset] ?? 'av1Save') : 'h264';
  const viewerKbps = {
    h264: cappedTopKbps(applied.preset, true, settings.maxBitrateKbps),
    av1: av1ModeOf(choice)
      ? presetViewerKbps(applied.preset, choice, settings.maxBitrateKbps)
      : null,
  };
  const day = dailyBreakdown(applied, viewerKbps, o);
  const breakdown = scale(day, applied.daysPerMonth);
  const totalGB = sum(breakdown);
  const { gbAboveFree, usd } = costAboveFreeTier(totalGB, freeGB);
  const limitGB = settings.limitGB;
  const perHourOfDay = applied.hoursPerDay > 0 ? totalGB / applied.hoursPerDay : 0;
  const room = limitGB ?? freeGB;
  const hoursPerDayThatFit = perHourOfDay > 0 ? Math.min(24, room / perHourOfDay) : 24;

  let economy: Estimate['economy'] = null;
  if (settings.autoEconomy && limitGB !== null && totalGB > 0.9 * limitGB) {
    // In economy mode viewers get the middle layer (H.264 only: AV1 is a top-layer track), under
    // the economy cap.
    const middle = Math.min(MIDDLE_LAYER.kbps, ECONOMY_CAP.maxBitrateKbps);
    const economyDay = sum(dailyBreakdown(applied, { h264: middle, av1: null }, o));
    const fullDay = sum(day);
    const startsAtGB = 0.9 * limitGB;
    economy = { startsAtGB, totalGB: startsAtGB + (totalGB - startsAtGB) * (economyDay / fullDay) };
  }

  return {
    applied,
    clamped,
    breakdown,
    totalGB,
    gbAboveFree,
    costUsd: usd,
    limitGB,
    fits: limitGB === null || totalGB <= limitGB,
    hoursPerDayThatFit,
    economy,
    viewerKbps,
  };
}

// Workers and Durable Objects. The measured hour of the normal group (5 friends: 1
// streams, 4 watch, all in voice, 20 chat messages) in apps/api/test/free-tier-budget.ts; the
// estimate scales it by person-hours. Requests count incoming WebSocket messages 1:1, an upper
// bound (Cloudflare bills them 20:1).

export const WORKERS_GROUP_HOUR = {
  people: 5,
  doRowsWritten: 547,
  doRequests: 729,
} as const;

/** Workers Free daily caps and Workers Paid monthly included amounts (apps/api/src/usage/free-tier.ts). */
export const WORKERS_FREE_DAILY = { doRowsWritten: 100_000, doRequests: 100_000 } as const;
export const WORKERS_PAID_MONTHLY = { doRowsWritten: 50_000_000, doRequests: 1_000_000 } as const;
export const WORKERS_PAID_USD_PER_MILLION = { doRowsWritten: 1, doRequests: 0.15 } as const;

export type WorkersPlan = 'free' | 'paid';

export interface WorkersEstimate {
  plan: WorkersPlan;
  rowsWrittenPerDay: number;
  requestsPerDay: number;
  /** Free: the larger share of a daily cap one day uses. Paid: of the monthly included amounts. */
  share: number;
  /** Paid: the overage at list prices for the month; 0 on Free. */
  overageUsd: number;
}

/** What the scenario costs in Durable Objects, against the plan's limits. */
export function estimateWorkers(applied: EstimateScenario, plan: WorkersPlan): WorkersEstimate {
  // The streamers and their friends, or everyone in voice if more.
  const people = Math.max(applied.streamers + applied.viewers, applied.voicePeople);
  const groupHours = (people / WORKERS_GROUP_HOUR.people) * applied.hoursPerDay;
  const rowsWrittenPerDay = groupHours * WORKERS_GROUP_HOUR.doRowsWritten;
  const requestsPerDay = groupHours * WORKERS_GROUP_HOUR.doRequests;
  if (plan === 'free') {
    return {
      plan,
      rowsWrittenPerDay,
      requestsPerDay,
      share: Math.max(
        rowsWrittenPerDay / WORKERS_FREE_DAILY.doRowsWritten,
        requestsPerDay / WORKERS_FREE_DAILY.doRequests,
      ),
      overageUsd: 0,
    };
  }
  const month = {
    doRowsWritten: rowsWrittenPerDay * applied.daysPerMonth,
    doRequests: requestsPerDay * applied.daysPerMonth,
  };
  const over = (k: keyof typeof month) =>
    (Math.max(0, month[k] - WORKERS_PAID_MONTHLY[k]) / 1e6) * WORKERS_PAID_USD_PER_MILLION[k];
  return {
    plan,
    rowsWrittenPerDay,
    requestsPerDay,
    share: Math.max(
      month.doRowsWritten / WORKERS_PAID_MONTHLY.doRowsWritten,
      month.doRequests / WORKERS_PAID_MONTHLY.doRequests,
    ),
    overageUsd: over('doRowsWritten') + over('doRequests'),
  };
}
