// SPDX-License-Identifier: AGPL-3.0-only
import type { Capability, RoomCapabilities, RoomSettings } from '@openlive/protocol';

// Room capabilities as the API applies them (apps/api/src/room/capabilities.ts), the same rules
// and templates as the web's lib/capabilities.ts (a narrow copy): at least one of stream, voice
// and text, camera only with voice, each level within the one above.

export const CAPABILITIES = ['stream', 'voice', 'camera', 'text'] as const satisfies Capability[];

export const ALL_CAPABILITIES: RoomCapabilities = {
  stream: true,
  voice: true,
  camera: true,
  text: true,
};

/** The "Create room" templates, in the order the form shows them. */
export const TEMPLATES = {
  watchTogether: { stream: true, voice: true, camera: false, text: true },
  streamOnly: { stream: true, voice: false, camera: false, text: false },
  voice: { stream: false, voice: true, camera: false, text: false },
  text: { stream: false, voice: false, camera: false, text: true },
} as const satisfies Record<string, RoomCapabilities>;

export type TemplateId = keyof typeof TEMPLATES;
export type Template = TemplateId | 'custom';

export const TEMPLATE_IDS = [...(Object.keys(TEMPLATES) as TemplateId[]), 'custom'] as const;

export const isValidCapabilities = (c: RoomCapabilities): boolean =>
  (c.stream || c.voice || c.text) && (!c.camera || c.voice);

/** The capabilities in `c` that `ceiling` does not allow. */
export const aboveCeiling = (c: RoomCapabilities, ceiling: RoomCapabilities): Capability[] =>
  CAPABILITIES.filter((k) => c[k] && !ceiling[k]);

export const sameCapabilities = (a: RoomCapabilities, b: RoomCapabilities): boolean =>
  CAPABILITIES.every((k) => a[k] === b[k]);

/** Turns one capability on or off, keeping camera within voice. */
export function toggle(c: RoomCapabilities, key: Capability, on: boolean): RoomCapabilities {
  const next = { ...c, [key]: on };
  if (key === 'voice' && !on) next.camera = false;
  if (key === 'camera' && on) next.voice = true;
  return next;
}

/** The ceiling a level works within; unknown means everything. */
export const ceilingOf = (settings: RoomSettings | null | undefined): RoomCapabilities =>
  settings?.capabilities ?? ALL_CAPABILITIES;

/**
 * The template a new room starts from: "Watch together", or the first one the ceiling allows.
 */
export function firstTemplate(ceiling: RoomCapabilities): TemplateId {
  const ids = Object.keys(TEMPLATES) as TemplateId[];
  return ids.find((id) => aboveCeiling(TEMPLATES[id], ceiling).length === 0) ?? 'watchTogether';
}
