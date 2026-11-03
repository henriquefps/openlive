// SPDX-License-Identifier: AGPL-3.0-only
import type { Room } from '@openlive/client';
import type { LivePresence, RoomPresence, VoicePresence } from '@openlive/protocol';

// What a space screen shows per room: the room, who is in its voice and who streams (from the
// space socket, @openlive/client SpacePresenceConnection) and its unread chat messages (REST).

export interface RoomRow {
  room: Room;
  voice: VoicePresence[];
  live: LivePresence[];
  /** Unread chat messages, capped by the API at 100 (shown "99+"). */
  unread: number;
}

/** The rooms that are open, in the API's order, each with what is happening in it. */
export function roomRows(
  rooms: readonly Room[],
  presence: Readonly<Record<string, RoomPresence>>,
  unread: Readonly<Record<string, number>>,
): RoomRow[] {
  return rooms
    .filter((room) => room.archivedAt === null)
    .map((room) => ({
      room,
      voice: presence[room.id]?.voice ?? [],
      live: presence[room.id]?.live ?? [],
      unread: unread[room.id] ?? 0,
    }));
}

/** The first `max` names and how many more there are. */
export function namesWithMore(
  names: readonly string[],
  max: number,
): { shown: string[]; more: number } {
  return { shown: names.slice(0, max), more: Math.max(0, names.length - max) };
}

/** Who streams in a room, by name (a streamer without a socket in the room has none yet). */
export const streamerNames = (live: readonly LivePresence[]): string[] =>
  live.flatMap((l) => (l.displayName ? [l.displayName] : []));

/** Rooms with anything going on, for the badge on the space's row. */
export function activity(rows: readonly RoomRow[]): {
  live: number;
  voice: number;
  unread: number;
} {
  return rows.reduce(
    (sum, row) => ({
      live: sum.live + row.live.length,
      voice: sum.voice + row.voice.length,
      unread: sum.unread + row.unread,
    }),
    { live: 0, voice: 0, unread: 0 },
  );
}

/** The unread counts after the reader opened a room's chat: that room is read. */
export function markRoomRead(
  unread: Readonly<Record<string, number>>,
  roomId: string,
): Record<string, number> {
  return Object.fromEntries(Object.entries(unread).filter(([id]) => id !== roomId));
}
