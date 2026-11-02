// SPDX-License-Identifier: AGPL-3.0-only
import { Preset, type RoomCapabilities, type RoomSettings } from '@openlive/protocol';
import { z } from 'zod';
import { ApiError } from '../errors';
import {
  aboveCeiling,
  ALL_CAPABILITIES,
  capabilitiesSchema,
  fitDefault,
} from '../room/capabilities';
import { effectiveSettings } from '../room/settings';

// Space and room settings_json: each level only lowers the one above. A PATCH
// sets the given keys and removes the ones sent as null; the result is checked against the level
// above and refused (setting_above_ceiling) rather than silently clamped.

/** Quick rooms close this long after creation unless the space sets less. */
export const QUICK_ROOM_DEFAULT_HOURS = 12;
/** Upper bound for the space setting, so a "quick" room cannot outlive a day. */
export const QUICK_ROOM_MAX_HOURS = 24;

const count = z.int().min(0).max(1_000_000);

const limits = {
  maxStreams: count.nullable().optional(),
  maxViewersPerStream: count.nullable().optional(),
  maxBitrateKbps: count.nullable().optional(),
  maxVoiceParticipants: count.nullable().optional(),
  // Cameras on at once in the voice channel.
  maxCameras: count.nullable().optional(),
  allowedPresets: z.array(z.enum(Preset)).max(8).nullable().optional(),
  // A room's capabilities; for a space, the ones its rooms may have.
  capabilities: capabilitiesSchema.nullable().optional(),
  // A room's chat retention; for a space, the longest its rooms may keep.
  chatRetentionDays: z
    .union([z.literal(0), z.literal(7), z.literal(30), z.literal(90)])
    .nullable()
    .optional(),
};

export const roomSettingsPatch = z.strictObject({
  ...limits,
  // Guests may always listen; this says whether they speak.
  guestsCanSpeak: z.boolean().nullable().optional(),
  // Whether guests may turn a camera on (off by default).
  guestsCanUseCamera: z.boolean().nullable().optional(),
  // Guests may always read the chat; this says whether they write.
  guestsCanWrite: z.boolean().nullable().optional(),
});

export const spaceSettingsPatch = z.strictObject({
  ...limits,
  membersCanInviteGuests: z.boolean().nullable().optional(),
  quickRoomHours: z.int().min(1).nullable().optional(),
});

export function applyPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const given = Object.entries(patch).filter(([, value]) => value !== undefined);
  return Object.fromEntries(
    Object.entries({ ...current, ...Object.fromEntries(given) }).filter(([, v]) => v !== null),
  );
}

const NUMERIC = [
  'maxStreams',
  'maxViewersPerStream',
  'maxBitrateKbps',
  'maxVoiceParticipants',
  'maxCameras',
  'chatRetentionDays',
] as const;

/** Refuses any limit in `settings` above `ceiling`. `prefix` is the JSON Pointer of `settings`. */
export function checkLimits(
  settings: Record<string, unknown>,
  ceiling: RoomSettings,
  prefix: string,
): void {
  for (const key of NUMERIC) {
    const value = settings[key];
    const limit = ceiling[key];
    if (typeof value === 'number' && limit !== undefined && value > limit) {
      throw new ApiError(400, 'setting_above_ceiling', { path: `${prefix}/${key}`, limit });
    }
  }
  const presets = settings['allowedPresets'];
  if (Array.isArray(presets)) {
    const extra = presets.find((p) => !ceiling.allowedPresets.includes(p as Preset));
    if (extra !== undefined) throw new ApiError(403, 'preset_not_allowed', { preset: extra });
  }
  const hours = settings['quickRoomHours'];
  if (typeof hours === 'number' && hours > QUICK_ROOM_MAX_HOURS) {
    throw new ApiError(400, 'setting_above_ceiling', {
      path: `${prefix}/quickRoomHours`,
      limit: QUICK_ROOM_MAX_HOURS,
    });
  }
}

/** The limits a space's rooms work within: the platform ceilings lowered by the space. */
export const spaceLimits = (space: Record<string, unknown>, platform: RoomSettings): RoomSettings =>
  effectiveSettings(JSON.stringify(space), null, platform);

export const roomLimits = (
  space: Record<string, unknown>,
  room: Record<string, unknown>,
  platform: RoomSettings,
): RoomSettings => effectiveSettings(JSON.stringify(space), JSON.stringify(room), platform);

export function quickRoomHours(space: Record<string, unknown>): number {
  const hours = space['quickRoomHours'];
  return typeof hours === 'number' && Number.isInteger(hours) && hours >= 1
    ? Math.min(hours, QUICK_ROOM_MAX_HOURS)
    : QUICK_ROOM_DEFAULT_HOURS;
}

/**
 * Refuses capabilities the level above does not allow (setting_above_ceiling at the capability's
 * path). Checked only when a request sets them: a ceiling lowered later reduces what a room
 * effectively has without making its other settings unsaveable.
 */
export function checkCapabilities(
  capabilities: RoomCapabilities | null | undefined,
  ceiling: RoomCapabilities | undefined,
  prefix: string,
): void {
  if (!capabilities) return;
  const extra = aboveCeiling(capabilities, ceiling ?? ALL_CAPABILITIES)[0];
  if (extra !== undefined) {
    throw new ApiError(400, 'setting_above_ceiling', { path: `${prefix}/capabilities/${extra}` });
  }
}

/** A new room's capabilities: the requested ones, or the default (a template) fitted under the ceiling. */
export const newRoomCapabilities = (
  requested: RoomCapabilities | null | undefined,
  fallback: RoomCapabilities,
  ceiling: RoomCapabilities | undefined,
): RoomCapabilities => requested ?? fitDefault(fallback, ceiling ?? ALL_CAPABILITIES);
