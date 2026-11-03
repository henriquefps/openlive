// SPDX-License-Identifier: AGPL-3.0-only
import {
  RoomSession as CoreRoomSession,
  type RoomSessionParts,
  VoiceSessions as CoreVoiceSessions,
} from '@openlive/client';

// The app's voice session (voice survives navigation, as on Discord) is @openlive/client's
// RoomSession and VoiceSessions (voice/session.ts there has the story); this adds the web router's
// link to the room.

export {
  type NetworkMeterLike,
  type RoomSessionOptions,
  type RoomSessionParts,
  type SessionCamera,
  type SessionConnection,
  type SessionRtc,
  type SessionVoice,
  type VoiceEndNotice,
  type VoiceSessionsState,
  type WindowLike,
} from '@openlive/client';

/** Where the room page is, for "go to the room" from the voice panel. */
export type RoomLink =
  | { to: '/s/$spaceSlug/r/$roomSlug'; params: { spaceSlug: string; roomSlug: string } }
  | { to: '/rooms/$roomId'; params: { roomId: string } };

export class RoomSession<P extends RoomSessionParts = RoomSessionParts> extends CoreRoomSession<
  P,
  RoomLink
> {}

export class VoiceSessions<P extends RoomSessionParts = RoomSessionParts> extends CoreVoiceSessions<
  P,
  RoomLink
> {}
