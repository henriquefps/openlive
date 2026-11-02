// SPDX-License-Identifier: AGPL-3.0-only
import type { RtcSession } from '../rtc/session.ts';
import type { CameraApi } from './camera-api.ts';
import { CAMERA_ENCODINGS, type CameraMedia } from './camera.ts';
import { type CameraTrack, MAX_TRACKS_PER_PULL } from './contract.ts';

// Cameras on the room's SFU session, like voice (voice/media.ts): the camera is one
// sendonly simulcast video m-section, the others' cameras are pulled at most four per request, all
// through the session's queue. Each pulled camera is linked to its owner's pulled microphone, so
// the session puts both in one msid stream (lip sync).

export function sessionCameraMedia(session: RtcSession, api: CameraApi): CameraMedia {
  return {
    publish: (track) =>
      session.publish(
        track,
        async (sessionId, offer, mid) => {
          const res = await api.publish({ sessionId, sessionDescription: offer, mid });
          return res.sessionDescription;
        },
        CAMERA_ENCODINGS,
      ),
    unpublish: (publication) =>
      session.unpublish(publication, (sessionId) => api.unpublish(sessionId)),
    drop: (publication) => session.unpublish(publication, () => Promise.resolve()),
    pull: async (cameras, owner) => {
      const pulled = new Map<string, MediaStreamTrack>();
      for (let i = 0; i < cameras.length; i += MAX_TRACKS_PER_PULL) {
        const chunk: readonly CameraTrack[] = cameras.slice(i, i + MAX_TRACKS_PER_PULL);
        const got = await session.pullTracks(
          chunk.map((c) => c.trackId),
          async (sessionId) => {
            const res = await api.subscribe({ sessionId, trackIds: chunk.map((c) => c.trackId) });
            return {
              requiresImmediateRenegotiation: res.requiresImmediateRenegotiation,
              sessionDescription: res.sessionDescription,
              tracks: res.tracks.map((t) => ({ key: t.trackId, mid: t.mid })),
            };
          },
          (sessionId, trackId) => api.unsubscribe(sessionId, [trackId]),
          owner,
        );
        for (const [key, track] of got) pulled.set(key, track);
      }
      return pulled;
    },
    unpull: (trackIds, owner) => session.unpullTracks(trackIds, owner),
    setLayer: (trackId, rid) =>
      session.withSessionId((sessionId) => api.layer(sessionId, trackId, rid)),
    link: (links) => session.setMsidLinks(links),
    onReset: (listener) => session.onReset(listener),
  };
}
