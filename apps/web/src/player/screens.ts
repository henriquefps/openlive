// SPDX-License-Identifier: AGPL-3.0-only
import type { StreamEndReason, StreamInfo } from '@openlive/protocol';
import type { EndReason, RoomStatus, WatchAccess } from '../room/connection.ts';
import type { SourceState } from './source.ts';

// Every state the watch view can be in gets a screen of its own: never a black rectangle without an explanation. This is the one place that
// decides which, in priority order, from the room, the stream, the slot and the media source.

export type ScreenKind =
  | 'connecting'
  | 'live'
  /** Live, but the network forced a lower layer or keeps losing packets: the video stays. */
  | 'unstable'
  | 'paused'
  | 'curtain'
  | 'reconnecting'
  | 'ended'
  | 'noPermission'
  | 'roomExpired'
  | 'helperOffline'
  | 'helperOutdated'
  | 'full';

export const SCREEN_KINDS: readonly ScreenKind[] = [
  'connecting',
  'live',
  'unstable',
  'paused',
  'curtain',
  'reconnecting',
  'ended',
  'noPermission',
  'roomExpired',
  'helperOffline',
  'helperOutdated',
  'full',
];

/** Screens that leave the video visible (with at most a hint over it). */
export const VIDEO_SCREENS: ReadonlySet<ScreenKind> = new Set(['live', 'unstable']);

export interface ScreenInput {
  room: { status: RoomStatus; ended: EndReason | null };
  /** The stream as the room lists it; null once it left the room. */
  stream: StreamInfo | null;
  /** Why it ended, when the room said so while this page was open. */
  endedReason: StreamEndReason | null;
  /** This tab's slot or queue state; null before asking. */
  access: WatchAccess | null;
  /** The media source; null until there is a slot to pull with. */
  source: SourceState | null;
  /** The video track is muted: the source stopped sending (app-share's paused state). */
  trackMuted: boolean;
  /** A frame has been shown since the last (re)connect. */
  firstFrame: boolean;
  /** Automatic dropped below the top layer, or the last seconds lost packets. */
  unstable: boolean;
}

export function screenFor(input: ScreenInput): ScreenKind {
  const { room, stream, access, source } = input;
  if (room.status === 'ended') {
    const ended = room.ended;
    if (ended?.kind === 'closed' && ended.reason === 'expired') return 'roomExpired';
    if (ended?.kind === 'kicked' || ended?.kind === 'forbidden') return 'noPermission';
    if (ended?.kind === 'unauthenticated') return 'noPermission';
    return 'ended';
  }
  if (room.status === 'reconnecting') return 'reconnecting';
  if (room.status === 'connecting') return 'connecting';
  if (!stream) return input.endedReason === 'helper_disconnected' ? 'helperOffline' : 'ended';

  if (access?.kind === 'denied') return 'noPermission';
  if (access?.kind === 'full' || access?.kind === 'offer') return 'full';

  if (source?.kind === 'failed') {
    if (source.reason === 'no_permission') return 'noPermission';
    if (source.reason === 'helper_outdated') return 'helperOutdated';
    return 'reconnecting';
  }
  // The streamer's choice wins over the transport: a paused stream sends nothing on purpose.
  if (stream.paused) return stream.pauseReason === 'privacy_curtain' ? 'curtain' : 'paused';
  if (source?.kind === 'reconnecting') return 'reconnecting';
  if (access?.kind !== 'granted' || !source || source.kind === 'connecting') return 'connecting';
  // A new remote track starts muted until its first packets: only a muted track after frames
  // flowed means the source stopped sending.
  if (!input.firstFrame) return 'connecting';
  if (input.trackMuted) return 'paused';
  return input.unstable ? 'unstable' : 'live';
}
