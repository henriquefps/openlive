// SPDX-License-Identifier: AGPL-3.0-only
import type { Capability, RoomCapabilities, RoomSettings } from '@openlive/protocol';

// Room capabilities, as the API applies them
// (apps/api/src/room/capabilities.ts): at least one of stream, voice and text, camera only with
// voice, each level within the one above.

export const CAPABILITIES = ['stream', 'voice', 'camera', 'text'] as const satisfies Capability[];

export const ALL_CAPABILITIES: RoomCapabilities = {
  stream: true,
  voice: true,
  camera: true,
  text: true,
};

export const STREAM_ONLY: RoomCapabilities = {
  stream: true,
  voice: false,
  camera: false,
  text: false,
};

/** Quick rooms are short meetings: stream and voice. */
export const QUICK_ROOM_DEFAULT: RoomCapabilities = {
  stream: true,
  voice: true,
  camera: false,
  text: false,
};

/** The "Create room" templates, in the order the dialog shows them. */
export const TEMPLATES = {
  watchTogether: { stream: true, voice: true, camera: false, text: true },
  streamOnly: STREAM_ONLY,
  voice: { stream: false, voice: true, camera: false, text: false },
  text: { stream: false, voice: false, camera: false, text: true },
} as const satisfies Record<string, RoomCapabilities>;

export type Template = keyof typeof TEMPLATES | 'custom';

export const TEMPLATE_IDS = [
  ...(Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]),
  'custom',
] as const;

export const isValidCapabilities = (c: RoomCapabilities): boolean =>
  (c.stream || c.voice || c.text) && (!c.camera || c.voice);

/** The capabilities in `c` that `ceiling` does not allow. */
export const aboveCeiling = (c: RoomCapabilities, ceiling: RoomCapabilities): Capability[] =>
  CAPABILITIES.filter((k) => c[k] && !ceiling[k]);

export const sameCapabilities = (a: RoomCapabilities, b: RoomCapabilities): boolean =>
  CAPABILITIES.every((k) => a[k] === b[k]);

/** The template these capabilities match; "Voice channel" also covers voice with camera. */
export function templateOf(c: RoomCapabilities): Template {
  for (const id of Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]) {
    if (sameCapabilities(TEMPLATES[id], c)) return id;
  }
  if (sameCapabilities({ ...TEMPLATES.voice, camera: true }, c)) return 'voice';
  return 'custom';
}

/** Turns one capability on or off, keeping camera within voice. */
export function toggle(c: RoomCapabilities, key: Capability, on: boolean): RoomCapabilities {
  const next = { ...c, [key]: on };
  if (key === 'voice' && !on) next.camera = false;
  if (key === 'camera' && on) next.voice = true;
  return next;
}

/** A room's effective capabilities; a server before capabilities means stream-only. */
export const capabilitiesOf = (settings: RoomSettings | null | undefined): RoomCapabilities =>
  settings?.capabilities ?? STREAM_ONLY;

/** The ceiling a level works within; unknown means everything. */
export const ceilingOf = (settings: RoomSettings | null | undefined): RoomCapabilities =>
  settings?.capabilities ?? ALL_CAPABILITIES;
