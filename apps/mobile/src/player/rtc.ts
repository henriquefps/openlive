// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ApiClient,
  CodecPreference,
  createRtcApi,
  type PeerLike,
  RtcSession,
  RtcSource,
} from '@openlive/client';
import type { StreamInfo } from '@openlive/protocol';
import {
  MediaStream,
  type MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpReceiver,
} from 'react-native-webrtc';

// react-native-webrtc under the shared RTC code (@openlive/client): the session is the room's one
// SFU session, a source is one watched stream on it, and the codec choice reads the
// decoders libwebrtc lists on this device. AV1 is asked for only when that list has it; the Worker
// still answers with H.264 when the room does not allow AV1 for the stream. The
// "AV1 failed on this device" flag lives for the app's run: a restart tries AV1 again.

export type RnSession = RtcSession<MediaStreamTrack>;
export type RnSource = RtcSource<MediaStreamTrack, MediaStream>;

const capabilities = (kind: 'video') => {
  try {
    return RTCRtpReceiver.getCapabilities(kind) as { codecs: { mimeType: string }[] } | null;
  } catch {
    return null;
  }
};

/**
 * react-native-webrtc decodes AV1 in software (dav1d); H.264 has the phone's hardware decoder
 * (c2.qti.avc.decoder). Measured on a Galaxy S24 Ultra at 3440x1440@60: dav1d decodes at 10–16 ms
 * a frame (a 16.7 ms budget) and the app froze; so the app asks for H.264 and leaves AV1 out of
 * the list it offers the codec choice.
 */
const hardwareCapabilities = (kind: 'video') => {
  const all = capabilities(kind);
  return all
    ? { codecs: all.codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/av1') }
    : null;
};

/** Shared by every source of the app run: H.264 (hardware), AV1 only if this list ever allows it. */
export const codecPreference = new CodecPreference(hardwareCapabilities);

/** Whether this device lists an AV1 decoder (for the stats overlay and the tests of a phone). */
export const deviceListsAv1 = (): boolean =>
  (capabilities('video')?.codecs ?? []).some((c) => c.mimeType.toLowerCase() === 'video/av1');

export function createSession(api: ApiClient, roomId: string): RnSession {
  return new RtcSession<MediaStreamTrack>({
    api: createRtcApi(api, roomId),
    createPeer: (configuration) =>
      new RTCPeerConnection(configuration as never) as unknown as PeerLike<MediaStreamTrack>,
  });
}

export function createSource(session: RnSession, stream: StreamInfo, slotId: string): RnSource {
  return new RtcSource<MediaStreamTrack, MediaStream>(session, {
    stream,
    slotId,
    createStream: () => new MediaStream(),
    preferredCodec: () => codecPreference.preferred(),
    noteAv1Failure: () => codecPreference.noteAv1Failure(),
  });
}

/** The remote audio tracks' volume: 0 is silent, 1 the sent level (react-native-webrtc 0–10). */
export function setAudioVolume(stream: MediaStream, volume: number): void {
  for (const track of stream.getAudioTracks()) {
    (track as unknown as { _setVolume(volume: number): void })._setVolume(volume);
  }
}
