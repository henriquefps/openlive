// SPDX-License-Identifier: AGPL-3.0-only
import { Preset, type RoomSettings } from '@openlive/protocol';
import { DEFAULT_MAX_CAMERAS } from '@openlive/usage';
import { ALL_CAPABILITIES, intersect, parseCapabilities, STREAM_ONLY } from './capabilities';
import { DEFAULT_CHAT_RETENTION_DAYS, isRetention, MAX_CHAT_RETENTION_DAYS } from './chat';

// Effective room limits: each level only lowers the one above.

/**
 * People in a voice channel at once. Each listener pulls N-1 microphones; above ~12 the room would
 * have to pick who is heard.
 */
export const DEFAULT_MAX_VOICE_PARTICIPANTS = 12;

/** Platform defaults until platform_settings has an admin panel. */
export const PLATFORM_DEFAULTS: RoomSettings = {
  maxStreams: 5,
  maxViewersPerStream: 6,
  // 13 Mbps so the helper's default 1080p60 preset (~12.6 Mbit/s with audio) fits uncapped
  // (Henrique, 2026-10-27).
  maxBitrateKbps: 13_000,
  allowedPresets: [Preset.Text, Preset.Game, Preset.Max],
  capabilities: ALL_CAPABILITIES,
  maxVoiceParticipants: DEFAULT_MAX_VOICE_PARTICIPANTS,
  guestsCanSpeak: true,
  maxCameras: DEFAULT_MAX_CAMERAS,
  guestsCanUseCamera: false,
  // The platform's retention ceiling; a room's default is DEFAULT_CHAT_RETENTION_DAYS.
  chatRetentionDays: MAX_CHAT_RETENTION_DAYS,
  guestsCanWrite: true,
};

function parse(json: string | null): Partial<RoomSettings> {
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' ? (value as Partial<RoomSettings>) : {};
  } catch {
    return {};
  }
}

const lower = (ceiling: number, value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? Math.min(ceiling, value)
    : ceiling;

/**
 * Reduces the platform defaults by the space's and then the room's settings_json. Without a room
 * (roomJson null) the result is the ceiling the space's rooms work within.
 */
export function effectiveSettings(
  spaceJson: string | null,
  roomJson: string | null,
  platform: RoomSettings = PLATFORM_DEFAULTS,
): RoomSettings {
  // Capabilities: an unset space allows what the platform does; an unset room is stream-only.
  let capabilities = intersect(
    platform.capabilities ?? ALL_CAPABILITIES,
    parseCapabilities(parse(spaceJson).capabilities) ?? ALL_CAPABILITIES,
  );
  if (roomJson !== null) {
    capabilities = intersect(
      capabilities,
      parseCapabilities(parse(roomJson).capabilities) ?? STREAM_ONLY,
    );
  }
  let result = platform;
  for (const level of [parse(spaceJson), parse(roomJson)]) {
    const presets = Array.isArray(level.allowedPresets) ? level.allowedPresets : null;
    result = {
      maxStreams: lower(result.maxStreams, level.maxStreams),
      maxViewersPerStream: lower(result.maxViewersPerStream, level.maxViewersPerStream),
      maxBitrateKbps: lower(result.maxBitrateKbps, level.maxBitrateKbps),
      allowedPresets: presets
        ? result.allowedPresets.filter((p) => presets.includes(p))
        : result.allowedPresets,
      maxVoiceParticipants: lower(
        result.maxVoiceParticipants ?? DEFAULT_MAX_VOICE_PARTICIPANTS,
        level.maxVoiceParticipants,
      ),
      maxCameras: lower(result.maxCameras ?? DEFAULT_MAX_CAMERAS, level.maxCameras),
    };
  }
  // A room's own choice: guests speak unless the room says no.
  const guestsCanSpeak = roomJson === null || parse(roomJson).guestsCanSpeak !== false;
  // Cameras cost egress: guests turn one on only where the room says so.
  const guestsCanUseCamera = roomJson !== null && parse(roomJson).guestsCanUseCamera === true;
  // The text chat: the same for writing, and a retention the
  // room picks under the space's ceiling (without a room: the ceiling itself).
  const guestsCanWrite = roomJson === null || parse(roomJson).guestsCanWrite !== false;
  const spaceRetention = parse(spaceJson).chatRetentionDays;
  const roomRetention = parse(roomJson).chatRetentionDays;
  const retentionCeiling = Math.min(
    platform.chatRetentionDays ?? MAX_CHAT_RETENTION_DAYS,
    isRetention(spaceRetention) ? spaceRetention : MAX_CHAT_RETENTION_DAYS,
  );
  const chatRetentionDays = Math.min(
    retentionCeiling,
    roomJson === null
      ? retentionCeiling
      : isRetention(roomRetention)
        ? roomRetention
        : DEFAULT_CHAT_RETENTION_DAYS,
  ) as RoomSettings['chatRetentionDays'];
  // AV1 is the platform admin's choice, for the presets this room still allows,
  // and so is its mode.
  const av1Presets = (platform.av1Presets ?? []).filter((p) => result.allowedPresets.includes(p));
  const av1QualityPresets = (platform.av1QualityPresets ?? []).filter((p) =>
    av1Presets.includes(p),
  );
  return {
    ...result,
    ...(av1Presets.length > 0 ? { av1Presets } : {}),
    ...(av1QualityPresets.length > 0 ? { av1QualityPresets } : {}),
    capabilities,
    guestsCanSpeak,
    guestsCanUseCamera,
    ...(chatRetentionDays !== undefined ? { chatRetentionDays } : {}),
    guestsCanWrite,
  };
}
