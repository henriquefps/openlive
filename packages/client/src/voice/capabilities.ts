// SPDX-License-Identifier: AGPL-3.0-only
import type { RoomCapabilities, RoomSettings } from '@openlive/protocol';

/** Stream only: what a room has while its settings are unknown. */
export const STREAM_ONLY: RoomCapabilities = {
  stream: true,
  voice: false,
  camera: false,
  text: false,
};

/** What the room has: its settings' capabilities, else the stream alone. */
export const capabilitiesOf = (settings: RoomSettings | null | undefined): RoomCapabilities =>
  settings?.capabilities ?? STREAM_ONLY;
