// SPDX-License-Identifier: AGPL-3.0-only
import type {
  VoiceCameraStoppedPayload,
  VoiceJoinedPayload,
  VoiceLeftPayload,
  VoiceTracksPayload,
  VoiceUpdatedPayload,
} from '@openlive/protocol';

// The voice contract as the clients see it (docs/PROTOCOL.md 7.5, 7.7 and 11.2, protocol 1.12):
// the room socket's voice.* messages and the SFU proxy's voice routes. Types only: a runtime
// import of @openlive/protocol would bundle its validators.

export type {
  CameraLayerRequest,
  CameraPublishRequest,
  CameraPublishResponse,
  CameraStopReason,
  CameraSubscribeRequest,
  CameraSubscribeResponse,
  CameraTrack,
  VoiceLeftReason,
  VoiceParticipant,
  VoicePublishRequest,
  VoicePublishResponse,
  VoiceSubscribeRequest,
  VoiceSubscribeResponse,
  VoiceTrack,
} from '@openlive/protocol';

/** Room socket, client → room (room/connection.ts). */
export type { VoiceOutgoing } from '../room/connection.ts';

/** Room socket, room → client. */
export interface VoiceIncoming {
  'voice.joined': VoiceJoinedPayload;
  'voice.left': VoiceLeftPayload;
  'voice.updated': VoiceUpdatedPayload;
  /** Only to the tab in voice: every published microphone of the others, the full list. */
  'voice.tracks': VoiceTracksPayload;
  /** Since 1.12, only to the tab in voice: the room turned this person's camera off. */
  'voice.cameraStopped': VoiceCameraStoppedPayload;
}

/** The SFU pulls at most this many tracks per request (PROTOCOL 11.2). */
export const MAX_TRACKS_PER_PULL = 4;
