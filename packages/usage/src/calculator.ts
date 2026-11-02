// SPDX-License-Identifier: AGPL-3.0-only
// The egress cost formula. The onboarding calculator and the
// usage meter share it, so the onboarding estimate and the month's meter never
// disagree: egress = viewers × bitrate × time × overhead + joins × join overhead.
// Units are decimal: 1 GB = 10^9 bytes, 1 Mbps = 10^6 bits per second.

/** Realtime egress price above the free tier, in USD per GB. */
export const PRICE_USD_PER_GB = 0.05;
/** Free Realtime egress per month, shared by SFU and TURN. */
export const FREE_TIER_GB = 1000;

/** The camera strip's low layer (presets.ts CAMERA_LAYERS.l); kept here to avoid an import cycle. */
const CAMERA_LOW_KBPS = 150;

const BYTES_PER_GB = 1e9;
const BYTES_PER_MB = 1e6;
const SECONDS_PER_HOUR = 3600;

/**
 * Billed-egress overheads measured during development (status **Proposed**:
 * placeholders until a dedicated test explains them).
 */
export interface Overheads {
  /** Billed bytes per byte of the received layer (~1.5). */
  bitrateMultiplier: number;
  /** Extra billed MB each time a viewer joins, at the reference bitrate (~15 MB). */
  joinMB: number;
  /** The bitrate at which joinMB was measured; the join cost scales linearly with bitrate. */
  joinReferenceMbps: number;
}

/** Defaults: ~1.5× the layer bitrate, ~15 MB per join at 1080p60 (8 Mbps). */
export const DEFAULT_OVERHEADS: Overheads = {
  bitrateMultiplier: 1.5,
  joinMB: 15,
  joinReferenceMbps: 8,
};

/** The plain formula: slots × bitrate × time, nothing else. */
export const NO_OVERHEADS: Overheads = {
  bitrateMultiplier: 1,
  joinMB: 0,
  joinReferenceMbps: 8,
};

export function overheads(enabled: boolean, custom: Partial<Overheads> = {}): Overheads {
  return { ...(enabled ? DEFAULT_OVERHEADS : NO_OVERHEADS), ...custom };
}

/** Billed GB for one viewer watching a layer of `bitrateMbps` for `seconds`. */
export function viewerStreamGB(bitrateMbps: number, seconds: number, o: Overheads): number {
  return (((bitrateMbps * 1e6) / 8) * seconds * o.bitrateMultiplier) / BYTES_PER_GB;
}

/** Billed GB for one viewer join at `bitrateMbps`. */
export function joinGB(bitrateMbps: number, o: Overheads): number {
  return (o.joinMB * (bitrateMbps / o.joinReferenceMbps) * BYTES_PER_MB) / BYTES_PER_GB;
}

/** The single formula: viewer-seconds of watching plus viewer joins, both at one bitrate. */
export function egressGB(
  input: { bitrateMbps: number; viewerSeconds: number; joins: number },
  o: Overheads,
): number {
  return (
    viewerStreamGB(input.bitrateMbps, input.viewerSeconds, o) +
    input.joins * joinGB(input.bitrateMbps, o)
  );
}

export interface Ceiling {
  bitrateMbps: number;
  /** Viewers per stream. */
  slots: number;
}

/** GB of one hour of a full stream: every slot watching, each slot joining once. */
export function fullStreamHourGB(c: Ceiling, o: Overheads): number {
  return egressGB(
    { bitrateMbps: c.bitrateMbps, viewerSeconds: c.slots * SECONDS_PER_HOUR, joins: c.slots },
    o,
  );
}

/** How many full-stream hours fit in the free tier each month. */
export function fullStreamHoursInFreeTier(c: Ceiling, o: Overheads, freeGB = FREE_TIER_GB): number {
  return freeGB / fullStreamHourGB(c, o);
}

/** GB above the free tier and what they cost. */
export function costAboveFreeTier(
  totalGB: number,
  freeGB = FREE_TIER_GB,
): { gbAboveFree: number; usd: number } {
  const gbAboveFree = Math.max(0, totalGB - freeGB);
  return { gbAboveFree, usd: gbAboveFree * PRICE_USD_PER_GB };
}

/**
 * Billed GB of one hour of cameras in a voice channel: every camera
 * is pulled by everyone else in voice, at `cameraKbps` (the strip's low layer, or the high one when
 * everyone enlarges), each pull joining once. 6 cameras among 6 people on the low layer: 30 pulls at
 * 150 kbps, ~2 GB an hour without overheads.
 */
export function cameraHourGB(
  input: { cameras: number; people: number; cameraKbps: number },
  o: Overheads,
): number {
  const pulls = input.cameras * Math.max(0, input.people - 1);
  return egressGB(
    { bitrateMbps: input.cameraKbps / 1000, viewerSeconds: pulls * SECONDS_PER_HOUR, joins: pulls },
    o,
  );
}

/** An editable monthly scenario, e.g. "2 streams a night, 2 h each, 4 viewers, 20 nights". */
export interface Scenario {
  streamsPerDay: number;
  hoursPerStream: number;
  viewersPerStream: number;
  days: number;
  bitrateMbps: number;
  /** Joins per viewer per stream (default 1: each viewer joins once). */
  joinsPerViewer?: number;
  /**
   * Cameras on during each stream (default 0), each pulled on the strip's low layer by the viewers
   *.
   */
  cameras?: number;
  /** The rate a camera is pulled at; the low layer by default. */
  cameraKbps?: number;
}

export interface ScenarioResult {
  totalGB: number;
  gbAboveFree: number;
  costUsd: number;
}

/** The scenario's cameras: each watched by the viewers (the streamer is one of the people). */
function monthlyCameraGB(s: Scenario, streams: number, o: Overheads): number {
  const cameras = s.cameras ?? 0;
  if (cameras <= 0) return 0;
  const hour = cameraHourGB(
    { cameras, people: s.viewersPerStream + 1, cameraKbps: s.cameraKbps ?? CAMERA_LOW_KBPS },
    o,
  );
  return streams * s.hoursPerStream * hour;
}

export function monthlyScenario(s: Scenario, o: Overheads, freeGB = FREE_TIER_GB): ScenarioResult {
  const streams = s.streamsPerDay * s.days;
  const totalGB =
    egressGB(
      {
        bitrateMbps: s.bitrateMbps,
        viewerSeconds: streams * s.viewersPerStream * s.hoursPerStream * SECONDS_PER_HOUR,
        joins: streams * s.viewersPerStream * (s.joinsPerViewer ?? 1),
      },
      o,
    ) + monthlyCameraGB(s, streams, o);
  const { gbAboveFree, usd } = costAboveFreeTier(totalGB, freeGB);
  return { totalGB, gbAboveFree, costUsd: usd };
}

export interface ReferenceProfile extends Ceiling {
  id: 'economy' | 'max' | 'max120';
  resolution: '1080p' | '1440p';
  fps: 60 | 120;
}

/** The two side-by-side reference profiles of the onboarding calculator. */
export const REFERENCE_PROFILES: readonly ReferenceProfile[] = [
  { id: 'economy', resolution: '1080p', fps: 60, bitrateMbps: 8, slots: 4 },
  { id: 'max', resolution: '1440p', fps: 60, bitrateMbps: 12, slots: 6 },
];

/**
 * The third profile, shown once the admin allows 120 fps: 1440p120 at ~20 Mbps for 6 slots, ~54 GB
 * an hour without overheads.
 */
export const REFERENCE_PROFILE_120: ReferenceProfile = {
  id: 'max120',
  resolution: '1440p',
  fps: 120,
  bitrateMbps: 20,
  slots: 6,
};

export interface ProfileSummary {
  id: ReferenceProfile['id'];
  fullStreamHourGB: number;
  fullStreamHoursInFreeTier: number;
}

export function compareProfiles(
  o: Overheads,
  freeGB = FREE_TIER_GB,
  profiles: readonly ReferenceProfile[] = REFERENCE_PROFILES,
): ProfileSummary[] {
  return profiles.map((p) => ({
    id: p.id,
    fullStreamHourGB: fullStreamHourGB(p, o),
    fullStreamHoursInFreeTier: fullStreamHoursInFreeTier(p, o, freeGB),
  }));
}
