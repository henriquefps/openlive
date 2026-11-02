// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraApi } from '../src/voice/camera-api.ts';
import { sessionCameraMedia } from '../src/voice/camera-media.ts';
import type { VoiceApi } from '../src/voice/api.ts';
import { sessionVoiceMedia } from '../src/voice/media.ts';
import { fakeTrack, setup } from './rtc-fakes.ts';

// Cameras on the room's SFU session (voice/camera-media.ts, rtc/session.ts, PROTOCOL 7.7): one
// simulcast sendonly video (h 360p ~500 kbps, l 180p ~150 kbps), layers turned off on a bad
// network without renegotiating, pulls of up to four cameras, the layer switch, and lip sync: a
// camera and its owner's microphone in one msid stream.

const settle = () => vi.advanceTimersByTimeAsync(0);

/** The SFU's offer for a pull: m-sections with their own msid streams, as Realtime sends them. */
const offer = (sections: { kind: 'audio' | 'video'; mid: string }[]) =>
  [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=msid-semantic: WMS *',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=mid:0',
    ...sections.flatMap(({ kind, mid }) => [
      `m=${kind} 9 UDP/TLS/RTP/SAVPF 96`,
      `a=mid:${mid}`,
      `a=msid:stream-${mid} track-${mid}`,
    ]),
    '',
  ].join('\r\n');

function fakeApis() {
  let mid = 10;
  const pulled: { kind: 'audio' | 'video'; mid: string }[] = [];
  const pull = (kind: 'audio' | 'video', trackIds: string[]) => {
    const tracks = trackIds.map((trackId) => ({
      trackId,
      userId: `u_${trackId}`,
      mid: String(mid++),
    }));
    pulled.push(...tracks.map((t) => ({ kind, mid: t.mid })));
    return {
      requiresImmediateRenegotiation: true,
      sessionDescription: { type: 'offer' as const, sdp: offer(pulled) },
      tracks,
    };
  };
  const camera = {
    publish: vi.fn<CameraApi['publish']>((request) =>
      Promise.resolve({
        trackId: 'ct_me',
        mid: request.mid,
        rids: ['h', 'l'],
        sessionDescription: { type: 'answer', sdp: 'sfu-camera-answer' },
      }),
    ),
    unpublish: vi.fn<CameraApi['unpublish']>(() => Promise.resolve()),
    subscribe: vi.fn<CameraApi['subscribe']>((request) =>
      Promise.resolve(pull('video', request.trackIds)),
    ),
    unsubscribe: vi.fn<CameraApi['unsubscribe']>(() => Promise.resolve()),
    layer: vi.fn<CameraApi['layer']>(() => Promise.resolve()),
  } satisfies CameraApi;
  const voice = {
    publish: vi.fn<VoiceApi['publish']>(),
    unpublish: vi.fn<VoiceApi['unpublish']>(() => Promise.resolve()),
    subscribe: vi.fn<VoiceApi['subscribe']>((request) =>
      Promise.resolve(pull('audio', request.trackIds)),
    ),
    unsubscribe: vi.fn<VoiceApi['unsubscribe']>(() => Promise.resolve()),
  } satisfies VoiceApi;
  return { camera, voice };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('cameras on the SFU session', () => {
  it('publishes the camera with two simulcast layers, and pauses layers without renegotiating', async () => {
    const { session, peer } = setup();
    const apis = fakeApis();
    const media = sessionCameraMedia(session, apis.camera);
    session.start();
    await settle();
    const publication = await media.publish(fakeTrack('video', 'cam'));
    const transceiver = peer().local[0];
    expect(transceiver?.init).toEqual({
      direction: 'sendonly',
      sendEncodings: [
        { rid: 'h', maxBitrate: 500_000, maxFramerate: 30 },
        { rid: 'l', scaleResolutionDownBy: 2, maxBitrate: 150_000, maxFramerate: 30 },
      ],
    });
    expect(apis.camera.publish).toHaveBeenCalledWith({
      sessionId: 's1',
      sessionDescription: { type: 'offer', sdp: 'local-offer' },
      mid: 'l0',
    });
    expect(peer().remote.at(-1)).toEqual({ type: 'answer', sdp: 'sfu-camera-answer' });

    // A poor network: the low layer only; a bad one: nothing.
    await publication.setActiveLayers((rid) => rid !== 'h');
    expect(transceiver?.parameters.at(-1)?.encodings.map((e) => [e.rid, e.active])).toEqual([
      ['h', false],
      ['l', true],
    ]);
    await publication.setActiveLayers(() => false);
    expect(transceiver?.parameters.at(-1)?.encodings.every((e) => !e.active)).toBe(true);
    expect(peer().remote).toHaveLength(2);

    await media.unpublish(publication);
    expect(transceiver?.stopped).toBe(true);
    expect(apis.camera.unpublish).toHaveBeenCalledWith('s1');
  });

  it("pulls a camera into its owner's microphone msid stream (lip sync), and switches layers", async () => {
    const { session, peer } = setup();
    const apis = fakeApis();
    const cameras = sessionCameraMedia(session, apis.camera);
    const voices = sessionVoiceMedia(session, apis.voice);
    session.start();
    await settle();
    const owner = {};
    await voices.pull([{ trackId: 'vt_bia', userId: 'u_bia' }], owner);
    const audioMid = String(
      peer().transceivers.find((t) => t.receiver.track.kind === 'audio')?.mid,
    );
    cameras.link([{ video: 'ct_bia', audio: 'vt_bia' }]);
    const got = await cameras.pull(
      [{ trackId: 'ct_bia', userId: 'u_bia', rids: ['h', 'l'] }],
      owner,
    );
    expect(got.get('ct_bia')?.kind).toBe('video');
    expect(apis.camera.subscribe).toHaveBeenCalledWith({ sessionId: 's1', trackIds: ['ct_bia'] });
    const videoMid = String(Number(audioMid) + 1);
    // The audio of the camera's owner moved into the camera's msid stream before it was applied.
    const sdp = String(peer().remote.at(-1)?.sdp);
    expect(sdp).toContain(`a=mid:${audioMid}\r\na=msid:stream-${videoMid} track-${audioMid}`);
    expect(sdp).toContain(`a=msid-semantic: WMS stream-${videoMid}`);

    await cameras.setLayer('ct_bia', 'h');
    expect(apis.camera.layer).toHaveBeenCalledWith('s1', 'ct_bia', 'h');

    await cameras.unpull(['ct_bia'], owner);
    expect(apis.camera.unsubscribe).toHaveBeenCalledWith('s1', ['ct_bia']);
  });

  it('pulls at most four cameras per request', async () => {
    const { session } = setup();
    const apis = fakeApis();
    const media = sessionCameraMedia(session, apis.camera);
    session.start();
    await settle();
    const list = ['a', 'b', 'c', 'd', 'e'].map((u) => ({
      trackId: `ct_${u}`,
      userId: `u_${u}`,
      rids: ['h', 'l'],
    }));
    const got = await media.pull(list, {});
    expect(got.size).toBe(5);
    expect(apis.camera.subscribe.mock.calls.map(([r]) => r.trackIds.length)).toEqual([4, 1]);
  });
});
