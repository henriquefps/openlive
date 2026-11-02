// SPDX-License-Identifier: AGPL-3.0-only
import type { RtcSession } from '../rtc/session.ts';
import type { VoiceApi } from './api.ts';
import type { VoiceMedia } from './client.ts';
import { MAX_TRACKS_PER_PULL, type VoiceTrack } from './contract.ts';

// Voice on the room's SFU session: the microphone is published as one sendonly audio
// m-section, the others' microphones are pulled at most four per request (the SFU's limit), all
// through the session's queue, so voice and stream pulls never interleave their SDP.

export function sessionVoiceMedia(session: RtcSession, api: VoiceApi): VoiceMedia {
  return {
    publish: (track) =>
      session.publish(track, async (sessionId, offer, mid) => {
        const res = await api.publish({ sessionId, sessionDescription: offer, mid });
        return res.sessionDescription;
      }),
    unpublish: (publication) =>
      session.unpublish(publication, (sessionId) => api.unpublish(sessionId)),
    pull: async (tracks, owner) => {
      const pulled = new Map<string, MediaStreamTrack>();
      for (let i = 0; i < tracks.length; i += MAX_TRACKS_PER_PULL) {
        const chunk: readonly VoiceTrack[] = tracks.slice(i, i + MAX_TRACKS_PER_PULL);
        const got = await session.pullTracks(
          chunk.map((t) => t.trackId),
          async (sessionId) => {
            const res = await api.subscribe({
              sessionId,
              trackIds: chunk.map((t) => t.trackId),
            });
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
    onReset: (listener) => session.onReset(listener),
  };
}
