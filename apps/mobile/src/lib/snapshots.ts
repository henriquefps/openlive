// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatEntry, ChatState, RoomState, SpacePresenceState } from '@openlive/client';
import type { ChatMessage, RoomPresence } from '@openlive/protocol';
import { capChat, type ChatSnapshot, type PresenceSnapshot, type RoomSnapshot } from './cache.ts';

// Socket-driven screens start from the last snapshot in the cache and let the live one replace it.
// These are the two directions, pure: the live state to a snapshot worth keeping, and a live state
// plus a snapshot to what the screen shows. `stale` is true while the snapshot is what is shown,
// so the screen can say "updating" in a corner instead of going blank.

// --- space presence ---

/** The snapshot to keep, or null until the space socket has delivered one. */
export function presenceSnapshot(live: SpacePresenceState, now: number): PresenceSnapshot | null {
  return live.status === 'open' ? { rooms: live.rooms, savedAt: now } : null;
}

export function presenceView(
  live: SpacePresenceState,
  seed: PresenceSnapshot | undefined,
): { rooms: Record<string, RoomPresence>; stale: boolean } {
  if (live.status === 'open' || !seed) return { rooms: live.rooms, stale: false };
  return { rooms: seed.rooms, stale: live.status !== 'ended' };
}

// --- room ---

/** The snapshot to keep: only once the welcome arrived and while the socket is open. */
export function roomSnapshot(live: RoomState, now: number): RoomSnapshot | null {
  if (live.status !== 'open' || live.you === null) return null;
  return {
    you: live.you,
    room: live.room,
    settings: live.settings,
    members: live.members,
    streams: live.streams,
    viewers: live.viewers,
    savedAt: now,
  };
}

/**
 * The room as the screen shows it. Until this connection's welcome arrives the last snapshot
 * stands in for who is here and what streams; from the welcome on the live state is shown,
 * including while it reconnects (its last known members stay).
 */
export function roomView(
  live: RoomState,
  seed: RoomSnapshot | undefined,
): { state: RoomState; stale: boolean } {
  if (live.you !== null || !seed || live.ended !== null) return { state: live, stale: false };
  return {
    state: {
      ...live,
      you: seed.you,
      room: seed.room,
      settings: seed.settings,
      members: seed.members,
      streams: seed.streams,
      viewers: seed.viewers,
    },
    stale: true,
  };
}

// --- chat ---

/** A message without the list's own bookkeeping (clientId, pending, failed). */
function plain(entry: ChatEntry): ChatMessage {
  const copy: Partial<ChatEntry> = { ...entry };
  delete copy.clientId;
  delete copy.pending;
  delete copy.failed;
  return copy as ChatMessage;
}

/** The snapshot to keep: the confirmed messages once the first page arrived. */
export function chatSnapshot(
  live: ChatState,
  room: Pick<RoomState, 'settings' | 'room'>,
  now: number,
): ChatSnapshot | null {
  if (live.status !== 'ready') return null;
  const messages = live.messages.filter((m) => !m.pending && !m.failed);
  return capChat({
    messages: messages.map(plain),
    hasMore: live.hasMore,
    lastReadId: live.lastReadId,
    retentionDays: room.settings?.chatRetentionDays,
    quick: room.room?.kind === 'quick',
    savedAt: now,
  });
}

/**
 * The chat as the panel shows it: the saved messages (read only, the panel is told the room is not
 * online) until the live chat has messages of its own, then the live one.
 */
export function chatView(
  live: ChatState,
  roomWelcomed: boolean,
  seed: ChatSnapshot | undefined,
): { state: ChatState; stale: boolean } {
  if (live.status === 'ready' || !seed) return { state: live, stale: false };
  // Chat switched off by a welcome: nothing to show, whatever was saved.
  if (roomWelcomed && live.status === 'off') return { state: live, stale: false };
  if (live.messages.length > 0) return { state: { ...live, status: 'ready' }, stale: true };
  return {
    state: {
      ...live,
      status: 'ready',
      messages: seed.messages,
      hasMore: false,
      lastReadId: seed.lastReadId,
    },
    stale: true,
  };
}
