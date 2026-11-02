// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceApi } from '../src/voice/api.ts';
import { sessionVoiceMedia } from '../src/voice/media.ts';
import { fakeTrack, setup } from './rtc-fakes.ts';

// Voice on the room's SFU session (voice/media.ts, rtc/session.ts): the microphone as a sendonly
// m-section offered by the browser, pulls of up to four tracks answered through renegotiate, and
// the same queue as stream pulls.

const settle = () => vi.advanceTimersByTimeAsync(0);

/** The SFU's offer for a voice pull: one audio m-section per track. */
const voiceOffer = (mids: string[]) =>
  [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=mid:0',
    ...mids.flatMap((mid) => ['m=audio 9 UDP/TLS/RTP/SAVPF 111', `a=mid:${mid}`]),
    '',
  ].join('\r\n');

function fakeVoiceApi() {
  let mid = 10;
  return {
    publish: vi.fn<VoiceApi['publish']>((request) =>
      Promise.resolve({
        trackId: 'tr_me',
        mid: request.mid,
        sessionDescription: { type: 'answer', sdp: 'sfu-publish-answer' },
      }),
    ),
    unpublish: vi.fn<VoiceApi['unpublish']>(() => Promise.resolve()),
    subscribe: vi.fn<VoiceApi['subscribe']>((request) => {
      const tracks = request.trackIds.map((trackId) => ({
        trackId,
        userId: `u_${trackId}`,
        mid: String(mid++),
      }));
      return Promise.resolve({
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: voiceOffer(tracks.map((t) => t.mid)) },
        tracks,
      });
    }),
    unsubscribe: vi.fn<VoiceApi['unsubscribe']>(() => Promise.resolve()),
  } satisfies VoiceApi;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('voice on the SFU session', () => {
  it('publishes the microphone: sendonly offer with its mid, then the SFU answer', async () => {
    const { session, peer, api } = setup();
    const voice = fakeVoiceApi();
    const media = sessionVoiceMedia(session, voice);
    session.start();
    await settle();
    const mic = fakeTrack('audio', 'mic');
    const publication = await media.publish(mic);
    expect(peer().local).toHaveLength(1);
    expect(voice.publish).toHaveBeenCalledWith({
      sessionId: 's1',
      sessionDescription: { type: 'offer', sdp: 'local-offer' },
      mid: 'l0',
    });
    expect(peer().remote.at(-1)).toEqual({ type: 'answer', sdp: 'sfu-publish-answer' });
    expect(publication).toMatchObject({ sessionId: 's1', mid: 'l0' });
    // No renegotiate for a publish: the SFU answered the offer.
    expect(api.renegotiate).not.toHaveBeenCalled();

    await publication.replaceTrack(null);
    expect(peer().local[0]?.sent).toEqual([mic, null]);

    await media.unpublish(publication);
    expect(peer().local[0]?.stopped).toBe(true);
    expect(voice.unpublish).toHaveBeenCalledWith('s1');
  });

  it('a refused publish stops the transceiver it added', async () => {
    const { session, peer } = setup();
    const voice = fakeVoiceApi();
    voice.publish.mockRejectedValueOnce(new Error('voice_speak_not_allowed'));
    session.start();
    await settle();
    await expect(
      sessionVoiceMedia(session, voice).publish(fakeTrack('audio', 'mic')),
    ).rejects.toThrow();
    expect(peer().local[0]?.stopped).toBe(true);
  });

  it('pulls at most four tracks per request and answers each SFU offer', async () => {
    const { session, api, peer } = setup();
    const voice = fakeVoiceApi();
    const media = sessionVoiceMedia(session, voice);
    const owner = {};
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const tracks = await media.pull(
      ids.map((trackId) => ({ trackId, userId: `u_${trackId}` })),
      owner,
    );
    expect(voice.subscribe.mock.calls.map(([r]) => r.trackIds)).toEqual([
      ['a', 'b', 'c', 'd'],
      ['e'],
    ]);
    expect(api.renegotiate).toHaveBeenCalledTimes(2);
    expect([...tracks.keys()]).toEqual(ids);
    expect(tracks.get('a')).toBe(peer().transceivers.find((t) => t.mid === '10')?.receiver.track);
  });

  it('pulling a track again closes the old pull first; unpull stops it and closes it', async () => {
    const { session, peer } = setup();
    const voice = fakeVoiceApi();
    const media = sessionVoiceMedia(session, voice);
    const owner = {};
    await media.pull([{ trackId: 'a', userId: 'u_a' }], owner);
    await media.pull([{ trackId: 'a', userId: 'u_a' }], owner);
    const first = peer().transceivers.find((t) => t.mid === '10');
    expect(first?.currentDirection).toBe('stopped');
    expect(voice.unsubscribe).toHaveBeenCalledWith('s1', ['a']);
    expect(voice.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(
      voice.subscribe.mock.invocationCallOrder[1] ?? 0,
    );

    await media.unpull(['a'], owner);
    expect(peer().transceivers.find((t) => t.mid === '11')?.currentDirection).toBe('stopped');
    expect(voice.unsubscribe).toHaveBeenCalledTimes(2);
    // Another owner's unpull leaves it alone.
    await media.pull([{ trackId: 'b', userId: 'u_b' }], owner);
    await media.unpull(['b'], {});
    expect(voice.unsubscribe).toHaveBeenCalledTimes(2);
  });
});
