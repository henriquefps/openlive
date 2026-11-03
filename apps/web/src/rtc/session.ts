// SPDX-License-Identifier: AGPL-3.0-only
import {
  type Publication as CorePublication,
  type PeerLike as CorePeerLike,
  type LocalTransceiverLike as CoreLocalTransceiverLike,
  type TransceiverLike as CoreTransceiverLike,
  type Pulled as CorePulled,
  RtcSession as CoreRtcSession,
  type SessionOptions as CoreSessionOptions,
} from '@openlive/client';

// The viewer's one SFU session per room is @openlive/client's RtcSession (rtc/session.ts
// there has the story: pre-connect, the serial queue, resets, publish and pull); this binds it to
// the browser's RTCPeerConnection and MediaStreamTrack.

export {
  PRECONNECT_RETRY_BASE_MS,
  PRECONNECT_RETRY_MAX_MS,
  QUOTA_WAIT_MS,
  RATE_LIMIT_WAIT_MS,
  SessionClosed,
  SessionReset,
  errorCodeOf,
  type MsidLink,
  type PullRequest,
  type SessionStatus,
  type TracksPulled,
} from '@openlive/client';

export type PeerLike = CorePeerLike<MediaStreamTrack>;
export type TransceiverLike = CoreTransceiverLike<MediaStreamTrack>;
export type LocalTransceiverLike = CoreLocalTransceiverLike<MediaStreamTrack>;
export type Publication = CorePublication<MediaStreamTrack>;
export type Pulled = CorePulled<MediaStreamTrack>;
export type SessionOptions = Omit<CoreSessionOptions<MediaStreamTrack>, 'createPeer'> & {
  createPeer?: CoreSessionOptions<MediaStreamTrack>['createPeer'];
};

export class RtcSession extends CoreRtcSession<MediaStreamTrack> {
  constructor(options: SessionOptions) {
    super({
      ...options,
      createPeer:
        options.createPeer ??
        ((configuration) =>
          new RTCPeerConnection(configuration as RTCConfiguration) as unknown as PeerLike),
    });
  }
}
