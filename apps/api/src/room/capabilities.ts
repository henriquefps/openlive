// SPDX-License-Identifier: AGPL-3.0-only
import { Capability, type RoomCapabilities } from '@openlive/protocol';
import { z } from 'zod';

// Room capabilities: stream, voice, camera (a sub-option of voice)
// and text. The same object is stored at three levels, like the other limits: the
// platform (platform_settings `capabilities`) and the space (settings_json `capabilities`) say
// what the level below may have, and the room (settings_json `capabilities`) what it has. Each
// level only restricts the one above.

export const CAPABILITIES = Object.values(Capability);

/** Every capability: the platform's default, and what an unset space allows. */
export const ALL_CAPABILITIES: RoomCapabilities = {
  stream: true,
  voice: true,
  camera: true,
  text: true,
};

/** A room with nothing stored: every room before capabilities existed (migration 0010). */
export const STREAM_ONLY: RoomCapabilities = {
  stream: true,
  voice: false,
  camera: false,
  text: false,
};

/** "Watch together": the default for fixed rooms. */
export const WATCH_TOGETHER: RoomCapabilities = {
  stream: true,
  voice: true,
  camera: false,
  text: true,
};

/** Quick rooms are short meetings: stream and voice. */
export const QUICK_ROOM_DEFAULT: RoomCapabilities = {
  stream: true,
  voice: true,
  camera: false,
  text: false,
};

/** At least one of stream, voice and text; camera only with voice. */
export const isValidCapabilities = (c: RoomCapabilities): boolean =>
  (c.stream || c.voice || c.text) && (!c.camera || c.voice);

export const capabilitiesSchema = z
  .strictObject({ stream: z.boolean(), voice: z.boolean(), camera: z.boolean(), text: z.boolean() })
  .refine(isValidCapabilities);

/** The stored object, or null when it is absent or malformed. */
export function parseCapabilities(value: unknown): RoomCapabilities | null {
  const parsed = capabilitiesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What is on in both. */
export const intersect = (a: RoomCapabilities, b: RoomCapabilities): RoomCapabilities => ({
  stream: a.stream && b.stream,
  voice: a.voice && b.voice,
  // Camera never outlives voice.
  camera: a.camera && b.camera && a.voice && b.voice,
  text: a.text && b.text,
});

/** The capabilities in `c` that `ceiling` does not allow. */
export const aboveCeiling = (c: RoomCapabilities, ceiling: RoomCapabilities): Capability[] =>
  CAPABILITIES.filter((k) => c[k] && !ceiling[k]);

/**
 * A default (a template) fitted under the ceiling. When nothing of it is left, everything the
 * ceiling allows: the ceiling itself is valid, so the result always is.
 */
export function fitDefault(wanted: RoomCapabilities, ceiling: RoomCapabilities): RoomCapabilities {
  const fitted = intersect(wanted, ceiling);
  return isValidCapabilities(fitted) ? fitted : { ...ceiling, camera: false };
}
