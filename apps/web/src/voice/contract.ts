// SPDX-License-Identifier: AGPL-3.0-only

// The voice contract as the web client sees it (docs/PROTOCOL.md 7.5, 7.7 and 11.2, protocol 1.12):
// it is @openlive/client's (voice/contract.ts there); this file keeps the web's import path.

export {
  MAX_TRACKS_PER_PULL,
  type CameraLayerRequest,
  type CameraPublishRequest,
  type CameraPublishResponse,
  type CameraStopReason,
  type CameraSubscribeRequest,
  type CameraSubscribeResponse,
  type CameraTrack,
  type VoiceIncoming,
  type VoiceLeftReason,
  type VoiceOutgoing,
  type VoiceParticipant,
  type VoicePublishRequest,
  type VoicePublishResponse,
  type VoiceSubscribeRequest,
  type VoiceSubscribeResponse,
  type VoiceTrack,
} from '@openlive/client';
