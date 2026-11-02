// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.ts';
import { httpRtcApi } from '../src/rtc/api.ts';
import { rtcMediaFactory } from '../src/rtc/media.ts';
import { QUOTA_WAIT_MS, RATE_LIMIT_WAIT_MS } from '../src/rtc/session.ts';
import { presetLayers, RtcSource } from '../src/rtc/source.ts';
import {
  createStream,
  type fakeApi,
  FakeMediaStream,
  type FakePeer,
  setup,
  sfuOffer,
  STREAM,
} from './rtc-fakes.ts';

// The rtc client's state machine against fakes (rtc-fakes.ts): session → subscribe → renegotiate
// → layer → leave, reconnects, retries and the leave beacon.

/** Lets every pending promise (fake API, fake peer) settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);
/** Every API call so far, by route name, in call order. */
const names = (api: ReturnType<typeof fakeApi>) =>
  Object.entries(api)
    .flatMap(([name, fn]) => fn.mock.invocationCallOrder.map((order) => ({ name, order })))
    .sort((a, b) => a.order - b.order)
    .map((c) => c.name);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RtcSession: pre-connect', () => {
  it('asks for ICE servers, offers a data channel only and applies the SFU answer', async () => {
    const { api, session, peer } = setup();
    session.start();
    expect(session.status).toBe('connecting');
    await settle();
    expect(names(api)).toEqual(['ice', 'session']);
    expect(peer().configuration.iceServers).toEqual([{ urls: ['stun:stun.example:3478'] }]);
    expect(peer().configuration.bundlePolicy).toBe('max-bundle');
    expect(peer().channels).toHaveLength(1);
    expect(api.session).toHaveBeenCalledWith({ type: 'offer', sdp: 'local-offer' });
    expect(peer().remote).toEqual([{ type: 'answer', sdp: 'sfu-answer' }]);
    expect(session.sessionId).toBe('s1');
    // DTLS connects with no media.
    expect(session.status).toBe('connecting');
    peer().set('connected');
    expect(session.status).toBe('connected');
    expect(session.connectMs).not.toBeNull();
  });

  it('start() twice opens one session', async () => {
    const { api, session } = setup();
    session.start();
    session.start();
    await settle();
    expect(names(api)).toEqual(['ice', 'session']);
  });

  it('close() closes the connection and sends the leave beacon', async () => {
    const { api, session, peer } = setup();
    session.start();
    await settle();
    session.close();
    expect(peer().closed).toBe(true);
    expect(api.leave).toHaveBeenCalledWith('s1');
    expect(session.status).toBe('closed');
  });

  it('a session created after close() is left at once (StrictMode, fast navigation)', async () => {
    const { api, session, peers } = setup();
    session.start();
    await Promise.resolve();
    session.close();
    await settle();
    expect(api.leave).toHaveBeenCalledWith('s1');
    expect(peers.every((p) => p.closed)).toBe(true);
    expect(session.sessionId).toBeNull();
  });

  it('a failed pre-connect tries again with backoff', async () => {
    const { api, session, peer } = setup();
    api.session
      .mockRejectedValueOnce(new ApiError(502, { code: 'sfu_error' }))
      .mockRejectedValueOnce(new ApiError(502, { code: 'sfu_error' }));
    session.start();
    await settle();
    expect(session.status).toBe('idle');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.session).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(api.session).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.session).toHaveBeenCalledTimes(3);
    peer().set('connected');
    expect(session.status).toBe('connected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.session).toHaveBeenCalledTimes(3);
  });

  it('close() cancels a pending pre-connect retry', async () => {
    const { api, session } = setup();
    api.ice.mockRejectedValueOnce(new TypeError('offline'));
    session.start();
    await settle();
    session.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.ice).toHaveBeenCalledTimes(1);
  });

  it('do_quota_exceeded: no session or ICE request until the wait is over, then sources pull', async () => {
    // Production on 2026-10-29: about ten POST .../session and .../ice in a row while the
    // Durable Objects free tier was used up. Now: one try, then nothing for QUOTA_WAIT_MS.
    const { api, session } = setup();
    api.ice.mockRejectedValueOnce(new ApiError(503, { code: 'do_quota_exceeded' }));
    session.start();
    await settle();
    expect(session.status).toBe('idle');
    const sources = [
      new RtcSource(session, { stream: STREAM, slotId: 'sl_1', createStream }),
      new RtcSource(session, {
        stream: { ...STREAM, streamId: 'st_2' },
        slotId: 'sl_2',
        createStream,
      }),
    ];
    for (const s of sources) s.start();
    await settle();
    // The sources wait without a timer of their own; the session asks nothing.
    expect(sources.map((s) => s.state.kind)).toEqual(['reconnecting', 'reconnecting']);
    await vi.advanceTimersByTimeAsync(QUOTA_WAIT_MS - 1_000);
    expect(names(api)).toEqual(['ice']);
    // A retry from the player while waiting fails at once, still without a request.
    sources[0]?.retry();
    await settle();
    expect(names(api)).toEqual(['ice']);
    // The wait is over: one pre-connect, and both sources pull on the new session.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(names(api).slice(0, 3)).toEqual(['ice', 'ice', 'session']);
    expect(api.subscribe).toHaveBeenCalledTimes(2);
    expect(sources.map((s) => s.state.kind)).toEqual(['live', 'live']);
  });

  it('a rate limit (429) waits a minute instead of the backoff', async () => {
    const { api, session } = setup();
    api.session.mockRejectedValueOnce(new ApiError(429, { code: 'rate_limited' }));
    session.start();
    await settle();
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_WAIT_MS - 1);
    expect(api.session).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.session).toHaveBeenCalledTimes(2);
    expect(session.sessionId).toBe('s1');
  });

  it('a failed pre-connect leaves the session idle; the next pull tries again', async () => {
    const { api, session, source } = setup();
    api.ice.mockRejectedValueOnce(new TypeError('offline'));
    session.start();
    await settle();
    expect(session.status).toBe('idle');
    const s = source();
    s.start();
    await settle();
    expect(names(api)).toEqual(['ice', 'ice', 'session', 'subscribe', 'renegotiate']);
    expect(s.state).toEqual({ kind: 'live' });
  });
});

describe('RtcSource: pull, layers, stop', () => {
  it('subscribes with the slot, applies the lip-synced offer and answers it', async () => {
    const { api, session, source, peer } = setup();
    session.start();
    await settle();
    const s = source();
    s.start();
    expect(s.state).toEqual({ kind: 'connecting' });
    await settle();
    // jsdom has no RTCRtpReceiver.getCapabilities: no AV1 decoder, so it asks for H.264.
    expect(api.subscribe).toHaveBeenCalledWith({
      sessionId: 's1',
      slotId: 'sl_1',
      streamId: 'st_1',
      codec: 'h264',
    });
    const applied = peer().remote.at(-1);
    expect(applied?.type).toBe('offer');
    // Audio joined the video's msid stream.
    expect(applied?.sdp).toContain('a=msid:sv ta');
    expect(applied?.sdp).toContain('a=msid-semantic: WMS sv');
    expect(api.renegotiate).toHaveBeenCalledWith('s1', { type: 'answer', sdp: 'local-answer-2' });
    expect(s.state).toEqual({ kind: 'live' });
    expect(s.layer).toBe('f');
    expect(s.layers).toEqual(presetLayers('game'));
    expect(s.stream.getTracks().map((t) => t.id)).toEqual(['video-1', 'audio-2']);
  });

  it('a stream without simulcast offers no layers', async () => {
    const { api, session, source } = setup();
    api.subscribe.mockResolvedValueOnce({
      streamId: 'st_1',
      requiresImmediateRenegotiation: true,
      sessionDescription: { type: 'offer', sdp: sfuOffer() },
      tracks: [{ mid: '1', kind: 'video' }],
    });
    session.start();
    const s = source();
    s.start();
    await settle();
    expect(s.layers).toEqual([]);
    expect(s.layer).toBeNull();
  });

  it('switches layers with PUT .../layer, the newest wanted layer winning', async () => {
    const { api, session, source } = setup();
    session.start();
    const s = source();
    s.start();
    await settle();
    let release: () => void = () => undefined;
    api.layer.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    s.setLayer('h');
    s.setLayer('q');
    await settle();
    expect(api.layer).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(api.layer.mock.calls.map((c) => c[0])).toEqual([
      { sessionId: 's1', streamId: 'st_1', rid: 'h' },
      { sessionId: 's1', streamId: 'st_1', rid: 'q' },
    ]);
    expect(s.layer).toBe('q');
    // No renegotiation for a layer switch.
    expect(api.renegotiate).toHaveBeenCalledTimes(1);
  });

  it('stops offering a layer the helper does not publish', async () => {
    const { api, session, source } = setup();
    session.start();
    const s = source();
    s.start();
    await settle();
    api.layer.mockRejectedValueOnce(new ApiError(400, { code: 'invalid_message' }));
    s.setLayer('h');
    await settle();
    expect(s.layers.map((l) => l.rid)).toEqual(['f', 'q']);
    expect(s.layer).toBe('f');
  });

  it('stop() closes the pulled tracks; the session stays for the next click', async () => {
    const { api, session, source, peer } = setup();
    session.start();
    const s = source();
    s.start();
    await settle();
    s.stop();
    await settle();
    expect(api.unsubscribe).toHaveBeenCalledWith('s1', 'st_1');
    expect(peer().closed).toBe(false);
    s.setLayer('h');
    expect(api.layer).not.toHaveBeenCalled();
  });

  it('stop() during the pull still unsubscribes after it', async () => {
    const { api, session, source } = setup();
    session.start();
    const s = source();
    s.start();
    s.stop();
    await settle();
    expect(names(api)).toEqual(['ice', 'session', 'subscribe', 'renegotiate', 'unsubscribe']);
    expect(s.state).toEqual({ kind: 'connecting' });
  });

  it('follows the layers the helper reports, without pulling again', async () => {
    const { api, session, source } = setup();
    session.start();
    const s = source({ preset: 'native' });
    s.start();
    await settle();
    expect(s.layers.map((l) => l.height)).toEqual([2160, 720, 480]);
    let changes = 0;
    s.subscribe(() => (changes += 1));
    const layers = [
      { rid: 'f', width: 3440, height: 1440, fps: 60, kbps: 25000 },
      { rid: 'h', width: 1728, height: 720, fps: 60, kbps: 3500 },
      { rid: 'q', width: 1152, height: 480, fps: 30, kbps: 1000 },
    ];
    s.update({ ...STREAM, preset: 'native', layers });
    expect(s.layers.map((l) => [l.width, l.height])).toEqual([
      [3440, 1440],
      [1728, 720],
      [1152, 480],
    ]);
    // A new StreamInfo with the same layers (a thumbnail, a viewer count) changes nothing.
    s.update({ ...STREAM, preset: 'native', layers, thumbnailAt: 5 });
    expect(changes).toBe(1);
    expect(api.subscribe).toHaveBeenCalledTimes(1);
  });

  it('a stream that resumes after a pause is pulled again (the SFU collects idle tracks)', async () => {
    const { api, session, source } = setup();
    session.start();
    const s = source();
    s.start();
    await settle();
    s.update({ ...STREAM, paused: true, pauseReason: 'source_hidden' });
    await settle();
    expect(api.subscribe).toHaveBeenCalledTimes(1);
    s.update({ ...STREAM, paused: false });
    expect(s.state).toEqual({ kind: 'reconnecting', attempt: 1 });
    await settle();
    expect(api.subscribe).toHaveBeenCalledTimes(2);
    expect(api.subscribe.mock.calls[1]?.[0]).toMatchObject({ rid: 'f' });
    expect(s.state).toEqual({ kind: 'live' });
  });
});

describe('pulling again on the same session', () => {
  /** The SFU's answer to the n-th pull: fresh mids, the older pulls' m-sections still offered. */
  const pullNumber = (api: ReturnType<typeof fakeApi>, streamId = 'st_1') => {
    let n = 0;
    api.subscribe.mockImplementation(() => {
      const older = Array.from({ length: n }, (_, i): [string, string] => [
        String(2 * i + 1),
        String(2 * i + 2),
      ]);
      const [video, audio] = [String(2 * n + 1), String(2 * n + 2)];
      n += 1;
      return Promise.resolve({
        streamId,
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: sfuOffer(video, audio, older) },
        tracks: [
          { mid: video, kind: 'video' },
          { mid: audio, kind: 'audio' },
        ],
        rid: 'f',
      });
    });
  };
  const live = (peer: FakePeer, kind: string) =>
    peer.transceivers.filter(
      (t) => t.receiver.track.kind === kind && t.currentDirection !== 'stopped',
    );

  it('closing and reopening the player stops the old receivers before the next pull', async () => {
    const { api, session, source, peer } = setup();
    pullNumber(api);
    session.start();
    await settle();
    for (let i = 0; i < 5; i++) {
      const s = source();
      s.start();
      await settle();
      expect(s.state).toEqual({ kind: 'live' });
      expect(live(peer(), 'video').map((t) => t.mid)).toEqual([String(2 * i + 1)]);
      s.stop();
      await settle();
      expect(live(peer(), 'video')).toEqual([]);
      expect(live(peer(), 'audio')).toEqual([]);
    }
    expect(names(api).slice(2)).toEqual(
      Array.from({ length: 5 }, () => ['subscribe', 'renegotiate', 'unsubscribe']).flat(),
    );
    // A stopped receiver's track is ended: no detached <video> keeps asking for keyframes.
    expect(peer().transceivers.filter((t) => t.receiver.track.readyState === 'live')).toEqual([]);
  });

  it('a new source for the same stream unsubscribes the old pull first, and owns the pull', async () => {
    const { api, session, source, peer } = setup();
    pullNumber(api);
    session.start();
    await settle();
    const first = source();
    first.start();
    await settle();
    // The new source pulls before the old one's stop() reaches the queue: the old stop() must not
    // close the new pull.
    const second = source();
    second.start();
    first.stop();
    await settle();
    expect(names(api).slice(2)).toEqual([
      'subscribe',
      'renegotiate',
      'unsubscribe',
      'subscribe',
      'renegotiate',
    ]);
    expect(second.state).toEqual({ kind: 'live' });
    expect(second.stream.getTracks().map((t) => t.id)).toEqual(['video-3', 'audio-4']);
    expect(live(peer(), 'video').map((t) => t.mid)).toEqual(['3']);
  });

  it('a retry on the same session stops the previous pull and never duplicates receivers', async () => {
    const { api, session, source, peer } = setup();
    pullNumber(api);
    session.start();
    await settle();
    const s = source();
    s.start();
    await settle();
    s.retry();
    await settle();
    s.retry();
    await settle();
    expect(names(api).slice(2)).toEqual([
      'subscribe',
      'renegotiate',
      'unsubscribe',
      'subscribe',
      'renegotiate',
      'unsubscribe',
      'subscribe',
      'renegotiate',
    ]);
    expect(live(peer(), 'video').map((t) => t.mid)).toEqual(['5']);
    expect(live(peer(), 'audio').map((t) => t.mid)).toEqual(['6']);
    expect(s.stream.getTracks().map((t) => t.id)).toEqual(['video-5', 'audio-6']);
  });

  it('switching streams releases only the stream that was closed', async () => {
    const { api, session, source, peer } = setup();
    pullNumber(api);
    session.start();
    await settle();
    const a = source();
    a.start();
    await settle();
    a.stop();
    const b = source({ streamId: 'st_2' });
    b.start();
    await settle();
    expect(api.unsubscribe.mock.calls).toEqual([['s1', 'st_1']]);
    expect(live(peer(), 'video').map((t) => t.mid)).toEqual(['3']);
    expect(b.state).toEqual({ kind: 'live' });
  });
});

describe('reconnect and failures', () => {
  it('a failed connection gets a new session and the source pulls again on it', async () => {
    const { api, session, source, peers } = setup();
    session.start();
    await settle();
    peers[0]?.set('connected');
    const s = source();
    s.start();
    await settle();
    const stream = s.stream;
    // The second pull lands on new mids, with new tracks.
    api.subscribe.mockResolvedValueOnce({
      streamId: 'st_1',
      requiresImmediateRenegotiation: true,
      sessionDescription: { type: 'offer', sdp: sfuOffer('3', '4') },
      tracks: [
        { mid: '3', kind: 'video' },
        { mid: '4', kind: 'audio' },
      ],
      rid: 'f',
    });
    const added = vi.fn();
    stream.addEventListener('addtrack', added);
    peers[0]?.set('failed');
    expect(peers[0]?.closed).toBe(true);
    expect(api.leave).toHaveBeenCalledWith('s1');
    expect(s.state).toEqual({ kind: 'reconnecting', attempt: 1 });
    await settle();
    expect(session.sessionId).toBe('s2');
    expect(api.subscribe.mock.calls[1]?.[0]).toMatchObject({ sessionId: 's2', slotId: 'sl_1' });
    expect(s.state).toEqual({ kind: 'live' });
    // The player keeps its MediaStream; only the tracks changed.
    expect(s.stream).toBe(stream);
    expect(stream.getTracks().map((t) => t.id)).toEqual(['video-3', 'audio-4']);
    expect(added).toHaveBeenCalled();
  });

  it('"disconnected" for longer than the grace period counts as failed', async () => {
    const { session, peers } = setup();
    session.start();
    await settle();
    peers[0]?.set('connected');
    peers[0]?.set('disconnected');
    await vi.advanceTimersByTimeAsync(4_000);
    peers[0]?.set('connected');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(peers).toHaveLength(1);
    peers[0]?.set('disconnected');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(peers).toHaveLength(2);
    expect(peers[0]?.closed).toBe(true);
  });

  it('a session the Worker forgot (sfu_session_not_found) is recreated and pulled again', async () => {
    const { api, session, source } = setup();
    session.start();
    await settle();
    api.subscribe.mockRejectedValueOnce(new ApiError(404, { code: 'sfu_session_not_found' }));
    const s = source();
    s.start();
    await settle();
    expect(names(api)).toEqual([
      'ice',
      'session',
      'subscribe',
      'leave',
      'ice',
      'session',
      'subscribe',
      'renegotiate',
    ]);
    expect(api.subscribe.mock.calls[1]?.[0]).toMatchObject({ sessionId: 's2' });
    expect(s.state).toEqual({ kind: 'live' });
  });

  it('retries a failed pull with backoff, then fails with "network"', async () => {
    const { api, session } = setup();
    api.subscribe.mockRejectedValue(new ApiError(502, { code: 'sfu_error' }));
    session.start();
    const s = new RtcSource(session, {
      stream: STREAM,
      slotId: 'sl_1',
      retryDelaysMs: [1_000, 2_000],
      createStream,
    });
    s.start();
    await settle();
    expect(s.state).toEqual({ kind: 'reconnecting', attempt: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.state).toEqual({ kind: 'reconnecting', attempt: 2 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.subscribe).toHaveBeenCalledTimes(3);
    expect(s.state).toEqual({ kind: 'failed', reason: 'network' });
    // The player's retry button starts over.
    api.subscribe.mockReset();
    api.subscribe.mockResolvedValue({
      streamId: 'st_1',
      requiresImmediateRenegotiation: true,
      sessionDescription: { type: 'offer', sdp: sfuOffer() },
      tracks: [{ mid: '1', kind: 'video' }],
      rid: 'f',
    });
    s.retry();
    await settle();
    expect(s.state).toEqual({ kind: 'live' });
  });

  it('a refused pull (403) is "no permission"; a lost slot waits for the room socket', async () => {
    const { api, session, source } = setup();
    session.start();
    api.subscribe.mockRejectedValueOnce(new ApiError(403, { code: 'forbidden' }));
    const a = source();
    a.start();
    await settle();
    expect(a.state).toEqual({ kind: 'failed', reason: 'no_permission' });
    api.subscribe.mockRejectedValueOnce(new ApiError(404, { code: 'slot_not_found' }));
    const b = source();
    b.start();
    await settle();
    expect(b.state).toEqual({ kind: 'connecting' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.subscribe).toHaveBeenCalledTimes(2);
  });

  it('back from the back/forward cache: a new session, and sources pull again', async () => {
    const { api, session, source } = setup();
    session.start();
    const s = source();
    s.start();
    await settle();
    session.close();
    await settle();
    session.start();
    await settle();
    expect(session.sessionId).toBe('s2');
    expect(api.subscribe.mock.calls[1]?.[0]).toMatchObject({ sessionId: 's2' });
    expect(s.state).toEqual({ kind: 'live' });
  });
});

describe('the media factory', () => {
  it('hands the player a source and its stream, and stops it', async () => {
    const { api, session } = setup();
    vi.stubGlobal('MediaStream', FakeMediaStream);
    try {
      session.start();
      const media = await rtcMediaFactory(session)({
        roomId: 'rm_1',
        stream: STREAM,
        slotId: 'sl_1',
      });
      await settle();
      expect(media.source.state).toEqual({ kind: 'live' });
      expect(media.stream.getTracks()).toHaveLength(2);
      media.update?.({ ...STREAM, preset: 'max' });
      expect(media.source.layers[0]).toEqual({ rid: 'f', height: 1440, fps: 60 });
      media.stop();
      await settle();
      expect(api.unsubscribe).toHaveBeenCalledWith('s1', 'st_1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('httpRtcApi', () => {
  it('leave() is a beacon to /api/rtc/leave with the room and the session', () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    try {
      httpRtcApi('rm_1').leave('s1');
      expect(beacon).toHaveBeenCalledWith(
        '/api/rtc/leave',
        JSON.stringify({ roomId: 'rm_1', sessionId: 's1' }),
      );
    } finally {
      Reflect.deleteProperty(navigator, 'sendBeacon');
    }
  });

  it('calls the SFU proxy routes of the room', async () => {
    const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const api = httpRtcApi('rm_1');
      await api.ice();
      await api.subscribe({ sessionId: 's1', slotId: 'sl_1', streamId: 'st_1', rid: 'h' });
      await api.layer({ sessionId: 's1', streamId: 'st_1', rid: 'q' });
      expect(fetchMock.mock.calls.map(([path, init]) => [init?.method, path, init?.body])).toEqual([
        ['POST', '/api/rtc/rooms/rm_1/ice', undefined],
        [
          'POST',
          '/api/rtc/rooms/rm_1/subscribe',
          JSON.stringify({ sessionId: 's1', slotId: 'sl_1', streamId: 'st_1', rid: 'h' }),
        ],
        [
          'PUT',
          '/api/rtc/rooms/rm_1/layer',
          JSON.stringify({ sessionId: 's1', streamId: 'st_1', rid: 'q' }),
        ],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
