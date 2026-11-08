// SPDX-License-Identifier: AGPL-3.0-only
import type { EndReason, RoomState } from '@openlive/client';
import type { Member, Preset, StreamInfo } from '@openlive/protocol';

// What the room screen shows from the room socket's state: the live streams as cards and the
// one line that says why the room is not live right now.

export interface StreamCard {
  streamId: string;
  userId: string;
  /** The streamer by name; null while they have no socket in the room. */
  streamer: string | null;
  /** The streamer's photo, when they have one. */
  streamerAvatar: string | null;
  /** When the latest thumbnail was stored (its version); null while there is none. */
  thumbnailAt: number | null;
  preset: Preset;
  source: string;
  paused: boolean;
  hasAudio: boolean;
  viewers: number;
  viewerLimit: number;
  startedAt: number;
  /** Streamed from a browser tab, not the helper (StreamInfo.origin, protocol 1.22). */
  browser: boolean;
}

/** The room's streams, oldest first, with the streamer's name from the members. */
export function streamCards(
  streams: readonly StreamInfo[],
  members: readonly Member[],
  viewers: Readonly<Record<string, { used: number }>> = {},
): StreamCard[] {
  return [...streams]
    .sort((a, b) => a.startedAt - b.startedAt || a.streamId.localeCompare(b.streamId))
    .map((s) => ({
      streamId: s.streamId,
      userId: s.userId,
      streamer: members.find((m) => m.userId === s.userId)?.displayName ?? null,
      streamerAvatar: members.find((m) => m.userId === s.userId)?.avatarUrl ?? null,
      thumbnailAt: s.thumbnailAt ?? null,
      preset: s.preset,
      source: s.source.label,
      paused: s.paused,
      hasAudio: s.hasAudio,
      viewers: viewers[s.streamId]?.used ?? s.viewerCount,
      viewerLimit: s.viewerLimit,
      startedAt: s.startedAt,
      browser: s.origin === 'browser',
    }));
}

/** Members in arrival order with the reader first, the rest by name. */
export function sortedMembers(members: readonly Member[], selfId: string | null): Member[] {
  return [...members].sort((a, b) => {
    if (a.userId === selfId) return -1;
    if (b.userId === selfId) return 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

export type RoomNotice =
  | { kind: 'connecting' }
  | { kind: 'reconnecting'; quota: boolean; brake?: boolean }
  | { kind: 'ended'; end: EndReason }
  | null;

/** The banner above the room: connecting, reconnecting, or why the socket stopped for good. */
export function roomNotice(
  state: Pick<RoomState, 'status' | 'ended' | 'quotaExceeded'> & { quotaBrake?: boolean },
): RoomNotice {
  switch (state.status) {
    case 'open':
      return null;
    case 'connecting':
      return { kind: 'connecting' };
    case 'reconnecting':
      return state.quotaBrake
        ? { kind: 'reconnecting', quota: state.quotaExceeded, brake: true }
        : { kind: 'reconnecting', quota: state.quotaExceeded };
    case 'ended':
      return state.ended
        ? { kind: 'ended', end: state.ended }
        : { kind: 'reconnecting', quota: false };
  }
}

/** The translation key for a room that ended (shared locales where they fit), and what to offer. */
export function endedText(end: EndReason): { key: string; retry: boolean; signIn: boolean } {
  switch (end.kind) {
    case 'kicked':
      return { key: `room.kickReason.${end.reason}`, retry: false, signIn: false };
    case 'closed':
      return { key: `room.closeReason.${end.reason}`, retry: false, signIn: false };
    case 'forbidden':
      return { key: 'room.connection.noAccess', retry: false, signIn: false };
    case 'unauthenticated':
      return { key: 'errors.unauthenticated', retry: false, signIn: true };
    case 'replaced':
      return { key: 'mobile.room.replaced', retry: true, signIn: false };
    case 'reload':
      return { key: 'errors.protocol_unsupported', retry: false, signIn: false };
  }
}

/** The stream's latest snapshot, a JPEG that needs the app token (docs/PROTOCOL.md section 11). */
export function thumbnailUrl(origin: string, streamId: string, version: number): string {
  return `${origin.replace(/\/+$/, '')}/api/streams/${encodeURIComponent(streamId)}/thumbnail?v=${version}`;
}
