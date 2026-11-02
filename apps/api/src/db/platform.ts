// SPDX-License-Identifier: AGPL-3.0-only
import { Preset, type RoomCapabilities, type RoomSettings } from '@openlive/protocol';
import {
  type Budget,
  DEFAULT_BRAKE_SETTINGS,
  DEFAULT_MAX_CAMERAS,
  DEFAULT_BUDGET,
  parseBudget,
  PRESET_CODECS,
  type PresetCodec,
  type QuotaMode,
} from '@openlive/usage';
import type { SpaceCreationPolicy } from '../auth/can';
import { ALL_CAPABILITIES, parseCapabilities } from '../room/capabilities';
import { DEFAULT_MAX_VOICE_PARTICIPANTS, PLATFORM_DEFAULTS } from '../room/settings';
import type { WorkersPlanSetting } from '../usage/cloudflare-limits';
import { auditStatement } from './audit';

// platform_settings: the platform admin's ceilings and quota choices.
// Three keys: `room_limits` (a RoomSettings every space and room stays within, plus the resolution
// and fps it was derived from), `budget` (the monthly limit, what happens when it is reached, the
// cycle) and `access` (who may create an account and who may create a space). The
// `budget` key also holds the viewer brakes 5 and 6. It replaced `quota`: until the settings are next saved, its values are read from there.

/** platform_settings key holding the room ceilings: a partial RoomSettings over PLATFORM_DEFAULTS. */
export const ROOM_LIMITS_KEY = 'room_limits';
/** platform_settings key holding the monthly limit and the brake choices. */
export const BUDGET_KEY = 'budget';
/** The key `budget` replaced: block or alerts only, the cycle day and the overheads. */
export const LEGACY_QUOTA_KEY = 'quota';
/** platform_settings key holding the sign-up and space creation policies. */
export const ACCESS_KEY = 'access';
/**
 * platform_settings key holding the room capabilities the instance allows (a RoomCapabilities).
 * Unset: all of them.
 */
export const CAPABILITIES_KEY = 'capabilities';

/** Who may create an account: only people arriving with an invite or a room code, or anyone. */
export const SIGNUP_POLICIES = ['invite_only', 'open'] as const;
export type SignupPolicy = (typeof SIGNUP_POLICIES)[number];
export const SPACE_CREATION_POLICIES = [
  'admin_only',
  'members',
] as const satisfies readonly SpaceCreationPolicy[];

export const RESOLUTIONS = ['1080p', '1440p', '2160p'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
/** 120 is the ceiling; the default stays 60, so the 120 fps presets are off. */
export const FRAME_RATES = [30, 60, 120] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

/** Everything the admin panel edits. */
export interface PlatformSettings {
  maxResolution: Resolution;
  maxFps: FrameRate;
  maxBitrateKbps: number;
  maxViewersPerStream: number;
  maxStreamsPerRoom: number;
  /** Cameras on at once in a room's voice channel (default 6). */
  maxCamerasPerRoom: number;
  /** The monthly limit: the free tier (default), a preset, a custom number of GB, or none. */
  budget: Budget;
  /** What happens at the limit: block new streams (default) or alerts only. Unused when unlimited. */
  quotaMode: QuotaMode;
  /** Enter economy mode above 90 % of the limit (default on). */
  autoEconomy: boolean;
  /** Brake 5: a viewer's tab hidden for 60 s stops receiving video until it is visible (default on). */
  backgroundPause: boolean;
  /** Brake 6: "Still watching?" after 2 h without interaction (default on). */
  idleCheck: boolean;
  /** Day of the month (1–31) the Cloudflare billing cycle turns over. */
  cycleResetDay: number;
  /** Whether estimates include the billed-egress overheads (~1.5× bitrate, ~15 MB per join). */
  overheads: boolean;
  /** Who may create an account (invite-only by default). */
  signup: SignupPolicy;
  /** Who may create a space (the platform admin only by default). */
  spaceCreation: SpaceCreationPolicy;
  /** The room capabilities spaces and rooms may have (all by default). */
  capabilities: RoomCapabilities;
  /**
   * Streams also publish their top layer in AV1 for viewers that decode it (off by
   * default until measured on real content).
   */
  allowAv1: boolean;
  /**
   * Per preset, with AV1 allowed: `av1Save` (AV1 for the viewers that decode it,
   * saving data; the default), `av1Quality` (AV1 at H.264's bitrate, a sharper picture) or `h264`
   * (H.264 only). Presets left out are `av1Save`.
   */
  presetCodecs: Partial<Record<Preset, PresetCodec>>;
}

export { PRESET_CODECS, type PresetCodec };

/** The presets that publish an AV1 track: none unless AV1 is allowed, then all but the H.264 ones. */
export function av1PresetsOf(
  allowed: readonly Preset[],
  allowAv1: boolean,
  presetCodecs: Partial<Record<Preset, PresetCodec>>,
): Preset[] {
  return allowAv1 ? allowed.filter((p) => presetCodecs[p] !== 'h264') : [];
}

/** The AV1 presets whose AV1 track runs at H.264's bitrate (`av1Quality`, protocol 1.17). */
export function av1QualityPresetsOf(
  allowed: readonly Preset[],
  allowAv1: boolean,
  presetCodecs: Partial<Record<Preset, PresetCodec>>,
): Preset[] {
  return allowAv1 ? allowed.filter((p) => presetCodecs[p] === 'av1Quality') : [];
}

/** A stored or sent codec choice: `auto`, the choice before AV1 modes, is `av1Save`. */
export function presetCodecOf(v: unknown): PresetCodec | undefined {
  if (v === 'auto') return 'av1Save';
  return (PRESET_CODECS as readonly unknown[]).includes(v) ? (v as PresetCodec) : undefined;
}

function parsePresetCodecs(v: unknown): Partial<Record<Preset, PresetCodec>> {
  if (!v || typeof v !== 'object') return {};
  // Stored values from before AV1 modes say `auto`; they read as `av1Save` and are written back
  // as such on the next save (no migration: platform_settings is JSON).
  return Object.fromEntries(
    Object.entries(v).flatMap(([preset, codec]) => {
      const c = presetCodecOf(codec);
      return (Object.values(Preset) as string[]).includes(preset) && c ? [[preset, c]] : [];
    }),
  );
}

export interface AccessPolicy {
  signup: SignupPolicy;
  spaceCreation: SpaceCreationPolicy;
}

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  maxResolution: '1440p',
  maxFps: 60,
  maxBitrateKbps: PLATFORM_DEFAULTS.maxBitrateKbps,
  maxViewersPerStream: PLATFORM_DEFAULTS.maxViewersPerStream,
  maxStreamsPerRoom: PLATFORM_DEFAULTS.maxStreams,
  maxCamerasPerRoom: DEFAULT_MAX_CAMERAS,
  budget: DEFAULT_BUDGET,
  quotaMode: DEFAULT_BRAKE_SETTINGS.mode,
  autoEconomy: DEFAULT_BRAKE_SETTINGS.autoEconomy,
  backgroundPause: true,
  idleCheck: true,
  cycleResetDay: 1,
  overheads: true,
  signup: 'invite_only',
  spaceCreation: 'admin_only',
  capabilities: ALL_CAPABILITIES,
  allowAv1: false,
  presetCodecs: {},
};

/**
 * The presets a resolution and fps ceiling allows: text and code fits any ceiling,
 * game needs 60 fps, max needs 1440p60 and native needs 2160p60. The 120 fps presets
 * need a 120 fps ceiling: game120 (1080p120) and, from 1440p, max120.
 */
export function presetsFor(resolution: Resolution, fps: FrameRate): Preset[] {
  const rank = RESOLUTIONS.indexOf(resolution);
  const out: Preset[] = [Preset.Text];
  if (fps >= 60) out.push(Preset.Game);
  if (fps >= 60 && rank >= 1) out.push(Preset.Max);
  if (fps >= 60 && rank >= 2) out.push(Preset.Native);
  if (fps >= 120) out.push(Preset.Game120);
  if (fps >= 120 && rank >= 1) out.push(Preset.Max120);
  return out;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

async function readJson(db: D1Database, key: string): Promise<Record<string, unknown>> {
  const row = await db
    .prepare('SELECT value_json FROM platform_settings WHERE key = ?')
    .bind(key)
    .first<{ value_json: string }>();
  return jsonObject(row?.value_json ?? null);
}

/** A platform_settings value_json as an object; {} when missing or not an object. */
export function jsonObject(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The room capabilities the instance allows. */
export async function platformCapabilities(db: D1Database): Promise<RoomCapabilities> {
  return parseCapabilities(await readJson(db, CAPABILITIES_KEY)) ?? ALL_CAPABILITIES;
}

/** The platform ceilings every space and room setting must stay within. */
export async function platformRoomLimits(db: D1Database): Promise<RoomSettings> {
  const [value, capabilities] = await Promise.all([
    readJson(db, ROOM_LIMITS_KEY),
    platformCapabilities(db),
  ]);
  return roomLimitsOf(value, capabilities);
}

/**
 * The `room_limits` value as a RoomSettings, with the defaults for anything unset or invalid, and
 * the instance's capabilities (a separate key, `capabilities`).
 */
export function roomLimitsOf(
  value: Record<string, unknown>,
  capabilities: RoomCapabilities = ALL_CAPABILITIES,
): RoomSettings {
  const allowedPresets = Array.isArray(value['allowedPresets'])
    ? (value['allowedPresets'] as RoomSettings['allowedPresets'])
    : PLATFORM_DEFAULTS.allowedPresets;
  const allowAv1 = value['allowAv1'] === true;
  const presetCodecs = parsePresetCodecs(value['presetCodecs']);
  const av1Presets = av1PresetsOf(allowedPresets, allowAv1, presetCodecs);
  const av1QualityPresets = av1QualityPresetsOf(allowedPresets, allowAv1, presetCodecs);
  return {
    capabilities,
    maxStreams: isCount(value['maxStreams']) ? value['maxStreams'] : PLATFORM_DEFAULTS.maxStreams,
    maxViewersPerStream: isCount(value['maxViewersPerStream'])
      ? value['maxViewersPerStream']
      : PLATFORM_DEFAULTS.maxViewersPerStream,
    maxBitrateKbps: isCount(value['maxBitrateKbps'])
      ? value['maxBitrateKbps']
      : PLATFORM_DEFAULTS.maxBitrateKbps,
    allowedPresets,
    ...(av1Presets.length > 0 ? { av1Presets } : {}),
    ...(av1QualityPresets.length > 0 ? { av1QualityPresets } : {}),
    maxVoiceParticipants: isCount(value['maxVoiceParticipants'])
      ? value['maxVoiceParticipants']
      : DEFAULT_MAX_VOICE_PARTICIPANTS,
    maxCameras: isCount(value['maxCameras']) ? value['maxCameras'] : DEFAULT_MAX_CAMERAS,
  };
}

const oneOf = <T>(values: readonly T[], v: unknown, fallback: T): T =>
  values.includes(v as T) ? (v as T) : fallback;

/** The sign-up and space creation policies, with the defaults for anything unset or invalid. */
export async function accessPolicy(db: D1Database): Promise<AccessPolicy> {
  const value = await readJson(db, ACCESS_KEY);
  const d = DEFAULT_PLATFORM_SETTINGS;
  return {
    signup: oneOf(SIGNUP_POLICIES, value['signup'], d.signup),
    spaceCreation: oneOf(SPACE_CREATION_POLICIES, value['spaceCreation'], d.spaceCreation),
  };
}

/** The admin panel's view of platform_settings, with defaults for anything unset or invalid. */
export async function platformSettings(db: D1Database): Promise<PlatformSettings> {
  const [limits, budget, legacy, room, access] = await Promise.all([
    platformRoomLimits(db),
    readJson(db, BUDGET_KEY),
    readJson(db, LEGACY_QUOTA_KEY),
    readJson(db, ROOM_LIMITS_KEY),
    accessPolicy(db),
  ]);
  // Before the first save after the upgrade only the legacy key exists.
  const quota = Object.keys(budget).length > 0 ? budget : legacy;
  const d = DEFAULT_PLATFORM_SETTINGS;
  const day = quota['cycleResetDay'];
  return {
    maxResolution: oneOf(RESOLUTIONS, room['maxResolution'], d.maxResolution),
    maxFps: oneOf(FRAME_RATES, room['maxFps'], d.maxFps),
    maxBitrateKbps: limits.maxBitrateKbps,
    maxViewersPerStream: limits.maxViewersPerStream,
    maxStreamsPerRoom: limits.maxStreams,
    maxCamerasPerRoom: limits.maxCameras ?? DEFAULT_MAX_CAMERAS,
    budget: parseBudget(quota['budget']) ?? d.budget,
    quotaMode: oneOf(['block', 'alerts_only'] as const, quota['mode'], d.quotaMode),
    autoEconomy: typeof quota['autoEconomy'] === 'boolean' ? quota['autoEconomy'] : d.autoEconomy,
    backgroundPause:
      typeof quota['backgroundPause'] === 'boolean' ? quota['backgroundPause'] : d.backgroundPause,
    idleCheck: typeof quota['idleCheck'] === 'boolean' ? quota['idleCheck'] : d.idleCheck,
    cycleResetDay: isCount(day) && day >= 1 && day <= 31 ? day : d.cycleResetDay,
    overheads: typeof quota['overheads'] === 'boolean' ? quota['overheads'] : d.overheads,
    ...access,
    capabilities: limits.capabilities ?? ALL_CAPABILITIES,
    allowAv1: room['allowAv1'] === true,
    presetCodecs: parsePresetCodecs(room['presetCodecs']),
  };
}

/**
 * Writes the keys and the audit entry in one batch (one transaction). A change to the access
 * policies or the capabilities gets its own entry too, with the values before and after.
 */
export async function savePlatformSettings(
  db: D1Database,
  s: PlatformSettings,
  actorId: string,
  now: number,
): Promise<{ capabilitiesChanged: boolean }> {
  const [before, capabilitiesBefore] = await Promise.all([
    accessPolicy(db),
    platformCapabilities(db),
  ]);
  const accessChanged = before.signup !== s.signup || before.spaceCreation !== s.spaceCreation;
  const capabilitiesChanged = JSON.stringify(capabilitiesBefore) !== JSON.stringify(s.capabilities);
  const upsert = (key: string, value: object) =>
    db
      .prepare(
        `INSERT INTO platform_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(key, JSON.stringify(value), actorId, now);
  await db.batch([
    upsert(ROOM_LIMITS_KEY, {
      maxStreams: s.maxStreamsPerRoom,
      maxViewersPerStream: s.maxViewersPerStream,
      maxBitrateKbps: s.maxBitrateKbps,
      maxCameras: s.maxCamerasPerRoom,
      allowedPresets: presetsFor(s.maxResolution, s.maxFps),
      maxResolution: s.maxResolution,
      maxFps: s.maxFps,
      allowAv1: s.allowAv1,
      presetCodecs: s.presetCodecs,
    }),
    upsert(BUDGET_KEY, {
      budget: s.budget,
      mode: s.quotaMode,
      autoEconomy: s.autoEconomy,
      backgroundPause: s.backgroundPause,
      idleCheck: s.idleCheck,
      cycleResetDay: s.cycleResetDay,
      overheads: s.overheads,
    }),
    db.prepare('DELETE FROM platform_settings WHERE key = ?').bind(LEGACY_QUOTA_KEY),
    upsert(ACCESS_KEY, { signup: s.signup, spaceCreation: s.spaceCreation }),
    upsert(CAPABILITIES_KEY, s.capabilities),
    auditStatement(
      db,
      { spaceId: null, actorId, action: 'platform.settings.update', target: null, data: { ...s } },
      now,
    ),
    ...(accessChanged
      ? [
          auditStatement(
            db,
            {
              spaceId: null,
              actorId,
              action: 'platform.access.update',
              target: null,
              data: {
                from: before,
                to: { signup: s.signup, spaceCreation: s.spaceCreation },
              },
            },
            now,
          ),
        ]
      : []),
    ...(capabilitiesChanged
      ? [
          auditStatement(
            db,
            {
              spaceId: null,
              actorId,
              action: 'platform.capabilities.update',
              target: null,
              data: { from: capabilitiesBefore, to: s.capabilities },
            },
            now,
          ),
        ]
      : []),
  ]);
  return { capabilitiesChanged };
}

/**
 * platform_settings key holding the Cloudflare Workers plan for the limits panel:
 * `detect` (default: the account's subscriptions say), `free` or `paid`.
 */
export const WORKERS_PLAN_KEY = 'workers_plan';

export async function workersPlanSetting(db: D1Database): Promise<WorkersPlanSetting> {
  const plan = (await readJson(db, WORKERS_PLAN_KEY))['plan'];
  return plan === 'free' || plan === 'paid' ? plan : 'detect';
}

export async function saveWorkersPlan(
  db: D1Database,
  plan: WorkersPlanSetting,
  actorId: string,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO platform_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(WORKERS_PLAN_KEY, JSON.stringify({ plan }), actorId, now),
    auditStatement(
      db,
      {
        spaceId: null,
        actorId,
        action: 'platform.settings.update',
        target: null,
        data: { workersPlan: plan },
      },
      now,
    ),
  ]);
}
