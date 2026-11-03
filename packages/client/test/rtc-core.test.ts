// SPDX-License-Identifier: AGPL-3.0-only
import type { StreamInfo } from '@openlive/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_DEFAULTS,
  BackgroundPause,
  CodecPreference,
  createApiClient,
  createRtcApi,
  IdleCheck,
  type PeerLike,
  type PlayerSource,
  PlaybackPolicy,
  type RtcApi,
  RtcSession,
  RtcSource,
  type StatsReportLike,
  streamLayers,
} from '../src/index.ts';

// The platform-free RTC core with fakes: the SFU proxy routes, the session's pull, the source's
// retry and layer rules, the codec choice, the playback loop and the brakes.

type Track = { id: string; kind: string };
const track = (kind: string): Track => ({ id: `${kind}-t`, kind });

const OFFER = [
  'v=0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=mid:0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:1',
  'a=msid:sv tv',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=mid:2',
  'a=msid:sa ta',
  '',
].join('\r\n');

function fakePeer(): PeerLike<Track> & { remote: string[] } {
  const remote: string[] = [];
  let local: { type: string; sdp: string } | null = null;
  const video = track('video');
  const audio = track('audio');
  return {
    remote,
    connectionState: 'connected',
    get localDescription() {
      return local;
    },
    onconnectionstatechange: null,
    createDataChannel: () => ({}),
    createOffer: () => Promise.resolve({ type: 'offer', sdp: 'offer-sdp' }),
    createAnswer: () => Promise.resolve({ type: 'answer', sdp: 'answer-sdp' }),
    setLocalDescription: (d) => {
      local = { type: d?.type ?? 'offer', sdp: d?.sdp ?? '' };
      return Promise.resolve();
    },
    setRemoteDescription: (d) => {
      remote.push(d.sdp ?? '');
      return Promise.resolve();
    },
    getTransceivers: () => [
      { mid: '1', currentDirection: 'recvonly', receiver: { track: video }, stop: vi.fn() },
      { mid: '2', currentDirection: 'recvonly', receiver: { track: audio }, stop: vi.fn() },
    ],
    addTransceiver: () => {
      throw new Error('not used');
    },
    getStats: () => Promise.resolve({ forEach: () => undefined }),
    close: vi.fn(),
  };
}

function fakeApi(): RtcApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ice: () => Promise.resolve({ iceServers: [] }),
    session: () => Promise.resolve({ sessionId: 'sfu_1', iceServers: [] }),
    subscribe: (request) => {
      calls.push(
        `subscribe ${request.streamId} ${request.slotId} ${request.rid ?? '-'} ${request.codec ?? '-'}`,
      );
      return Promise.resolve({
        streamId: request.streamId,
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: OFFER },
        tracks: [
          { mid: '1', kind: 'video' },
          { mid: '2', kind: 'audio' },
        ],
        rid: request.rid ?? 'f',
        codec: request.codec ?? 'h264',
      });
    },
    renegotiate: (sessionId) => {
      calls.push(`renegotiate ${sessionId}`);
      return Promise.resolve({});
    },
    layer: (request) => {
      calls.push(`layer ${request.rid}`);
      return Promise.resolve();
    },
    unsubscribe: (_s, streamId) => {
      calls.push(`unsubscribe ${streamId}`);
      return Promise.resolve();
    },
    leave: (sessionId) => void calls.push(`leave ${sessionId}`),
  };
}

const STREAM: StreamInfo = {
  streamId: 'st_1',
  userId: 'u_1',
  deviceId: 'd_1',
  source: { kind: 'window', label: 'Game' },
  preset: 'game',
  hasAudio: true,
  paused: false,
  startedAt: 0,
  viewerLimit: 6,
  viewerCount: 1,
};

class FakeStream {
  private tracks: Track[] = [];
  getTracks = () => [...this.tracks];
  addTrack = (t: Track) => void this.tracks.push(t);
  removeTrack = (t: Track) => void (this.tracks = this.tracks.filter((x) => x !== t));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('createRtcApi', () => {
  it('sends the SFU proxy routes of the room with the client (bearer or cookie)', async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response(JSON.stringify({ sessionId: 's1' }), { status: 200 })),
    );
    const client = createApiClient({ baseUrl: 'https://x.test/', fetch: fetch as never });
    const api = createRtcApi(client, 'room 1');
    await api.session(null);
    await api.layer({ sessionId: 's1', streamId: 'st', rid: 'h' });
    api.leave('s1');
    await settle();
    expect(fetch.mock.calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual([
      'POST https://x.test/api/rtc/rooms/room%201/session',
      'PUT https://x.test/api/rtc/rooms/room%201/layer',
      'POST https://x.test/api/rtc/leave',
    ]);
  });
});

describe('RtcSession and RtcSource', () => {
  function setup(preferred: () => 'h264' | 'av1' = () => 'av1') {
    const api = fakeApi();
    const peer = fakePeer();
    const session = new RtcSession<Track>({ api, createPeer: () => peer });
    session.start();
    const stream = new FakeStream();
    const source = new RtcSource<Track, FakeStream>(session, {
      stream: STREAM,
      slotId: 'sl_1',
      retryDelaysMs: [100, 200],
      createStream: () => stream,
      preferredCodec: preferred,
    });
    return { api, peer, session, source, stream };
  }

  it('pulls on the granted slot, answers the SFU and hands the tracks to the stream', async () => {
    const { api, peer, source, stream } = setup();
    source.start();
    await settle();
    expect(api.calls).toContain('subscribe st_1 sl_1 - av1');
    expect(api.calls).toContain('renegotiate sfu_1');
    expect(peer.remote[0]).toContain('a=msid:sv tv');
    expect(source.state).toEqual({ kind: 'live' });
    expect(source.codec).toBe('av1');
    expect(stream.getTracks().map((t) => t.kind)).toEqual(['video', 'audio']);
  });

  it('leaving the AV1 layer pulls H.264 and stays there; unknown layers are refused', async () => {
    const { api, source } = setup();
    source.start();
    await settle();
    source.update({ ...STREAM });
    expect(source.layers.map((l) => l.rid)).toEqual(['f', 'h', 'q']);
    source.setLayer('h');
    await settle();
    expect(api.calls.filter((c) => c.startsWith('subscribe')).at(-1)).toBe(
      'subscribe st_1 sl_1 h h264',
    );
    source.setLayer('f');
    await settle();
    expect(api.calls.at(-1)).toBe('layer f');
  });

  it('retries a failed pull with the delays, then fails with `network`', async () => {
    const { api, source } = setup();
    api.subscribe = () => Promise.reject(new Error('boom'));
    source.start();
    await settle();
    expect(source.state).toEqual({ kind: 'reconnecting', attempt: 1 });
    await vi.advanceTimersByTimeAsync(100);
    expect(source.state).toEqual({ kind: 'reconnecting', attempt: 2 });
    await vi.advanceTimersByTimeAsync(200);
    expect(source.state).toEqual({ kind: 'failed', reason: 'network' });
  });

  it('a stalled AV1 pull is pulled again in H.264, and the device is told when no frame came', async () => {
    const note = vi.fn();
    const api = fakeApi();
    const session = new RtcSession<Track>({ api, createPeer: fakePeer });
    session.start();
    const source = new RtcSource<Track, FakeStream>(session, {
      stream: STREAM,
      slotId: 'sl_1',
      createStream: () => new FakeStream(),
      preferredCodec: () => 'av1',
      noteAv1Failure: note,
    });
    source.start();
    await settle();
    source.retry({ framesDecoded: 0 });
    await settle();
    expect(api.calls.filter((c) => c.startsWith('subscribe')).at(-1)).toBe(
      'subscribe st_1 sl_1 f h264',
    );
    expect(note).toHaveBeenCalledOnce();
  });

  it('suspend closes the pull, resume pulls again', async () => {
    const { api, source } = setup();
    source.start();
    await settle();
    source.suspend();
    await settle();
    expect(api.calls).toContain('unsubscribe st_1');
    source.resume();
    await settle();
    expect(api.calls.filter((c) => c.startsWith('subscribe'))).toHaveLength(2);
  });

  it('stop closes the session’s pull', async () => {
    const { api, source, session } = setup();
    source.start();
    await settle();
    source.stop();
    await settle();
    expect(api.calls).toContain('unsubscribe st_1');
    session.close();
    expect(api.calls.at(-1)).toBe('leave sfu_1');
  });

  it('closeAfterUnpulls closes the pulls before it leaves', async () => {
    const { api, source, session } = setup();
    source.start();
    await settle();
    source.stop();
    void session.closeAfterUnpulls();
    await settle();
    const tail = api.calls.slice(api.calls.indexOf('unsubscribe st_1'));
    expect(tail).toEqual(['unsubscribe st_1', 'leave sfu_1']);
    expect(api.calls.filter((c) => c.startsWith('unsubscribe'))).toHaveLength(1);
  });

  it('closeAfterUnpulls yields to a restart', async () => {
    const { api, source, session } = setup();
    source.start();
    await settle();
    source.stop();
    void session.closeAfterUnpulls();
    session.start();
    await settle();
    expect(api.calls.some((c) => c.startsWith('leave'))).toBe(false);
  });
});

describe('streamLayers', () => {
  it('uses what the helper sends (1.19) and the preset’s nominal layers otherwise', () => {
    expect(streamLayers({ preset: 'game' }).map((l) => l.rid)).toEqual(['f', 'h', 'q']);
    expect(
      streamLayers({
        preset: 'game',
        layers: [{ rid: 'f', width: 3440, height: 1440, fps: 60, kbps: 20_000 }],
      }),
    ).toEqual([{ rid: 'f', width: 3440, height: 1440, fps: 60, kbps: 20_000 }]);
  });
});

describe('CodecPreference', () => {
  const caps =
    (...mime: string[]) =>
    () => ({ codecs: mime.map((mimeType) => ({ mimeType })) });

  it('asks for AV1 only when the device lists a decoder, and not after an AV1 failure', () => {
    const memory = { value: false };
    const store = {
      get: () => memory.value,
      set: () => void (memory.value = true),
      clear: () => void (memory.value = false),
    };
    const av1 = new CodecPreference(caps('video/H264', 'video/AV1'), store);
    expect(av1.preferred()).toBe('av1');
    expect(new CodecPreference(caps('video/H264')).preferred()).toBe('h264');
    expect(new CodecPreference(() => null).preferred()).toBe('h264');
    av1.noteAv1Failure();
    expect(av1.preferred()).toBe('h264');
    // Another instance on the same store remembers it (a reload of the tab).
    expect(new CodecPreference(caps('video/AV1'), store).preferred()).toBe('h264');
    av1.reset();
    expect(av1.preferred()).toBe('av1');
  });
});

describe('PlaybackPolicy', () => {
  function source(): { -readonly [K in keyof PlayerSource]: PlayerSource[K] } & {
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      state: { kind: 'live' },
      layers: [
        { rid: 'f', height: 1080, fps: 60 },
        { rid: 'h', height: 720, fps: 60 },
      ],
      layer: 'f',
      setLayer(rid) {
        calls.push(`layer ${rid}`);
        this.layer = rid;
      },
      getStats: () => Promise.resolve({ forEach: () => undefined }),
      retry: () => void calls.push('retry'),
      subscribe: () => () => undefined,
    };
  }
  const report = (frames: number, lost = 0, received = frames): StatsReportLike => ({
    forEach: (cb) =>
      cb({
        type: 'inbound-rtp',
        id: 'in',
        kind: 'video',
        framesDecoded: frames,
        packetsReceived: received,
        packetsLost: lost,
        lastPacketReceivedTimestamp: frames,
      }),
  });
  const inputs = { quality: 'auto', active: true, economy: false, cellular: false } as const;

  it('steps down one layer after a sustained bad stretch on Automatic', () => {
    const s = source();
    const policy = new PlaybackPolicy(s, 0);
    let t = 0;
    let frames = 0;
    let lost = 0;
    let received = 0;
    for (let i = 0; i < 12; i++) {
      t += 1000;
      frames += 60;
      received += 50;
      lost += 50; // half the packets lost
      policy.step(report(frames, lost, received), t, inputs);
    }
    expect(s.calls).toContain('layer h');
  });

  it('a fixed quality never runs Automatic, and reports an unstable network', () => {
    const s = source();
    const policy = new PlaybackPolicy(s, 0);
    policy.step(report(60), 1000, { ...inputs, quality: 'f' });
    const bad = policy.step(report(120, 100, 50), 2000, { ...inputs, quality: 'f' });
    expect(bad.unstable).toBe(true);
    expect(s.calls).not.toContain('layer h');
  });

  it('with phone options: a freeze at a steady fps and a lower layer are not "unstable"', () => {
    const phone = {
      ...AUTO_DEFAULTS,
      freezesNeedLowFps: true,
      unstableWindow: 4,
      unstableMin: 2,
      lowerLayerIsUnstable: false,
    };
    const frozen = (frames: number, freezes: number): StatsReportLike => ({
      forEach: (cb) =>
        cb({
          type: 'inbound-rtp',
          id: 'in',
          kind: 'video',
          framesDecoded: frames,
          packetsReceived: frames,
          packetsLost: 0,
          freezeCount: freezes,
          lastPacketReceivedTimestamp: frames,
        }),
    });
    const s = source();
    const policy = new PlaybackPolicy(s, 0, phone);
    let t = 0;
    let frames = 0;
    for (let i = 0; i < 10; i++) {
      t += 1000;
      frames += 60;
      // A "freeze" every second at 60 fps: not a problem the viewer sees.
      expect(policy.step(frozen(frames, i), t, inputs).unstable).toBe(false);
    }
    // The web's options flag the same stream.
    const web = new PlaybackPolicy(source(), 0);
    web.step(frozen(60, 0), 1000, inputs);
    expect(web.step(frozen(120, 1), 2000, inputs).unstable).toBe(true);
  });

  it('with phone options: a stall with freezes is unstable once it lasts, then clears', () => {
    const phone = { ...AUTO_DEFAULTS, freezesNeedLowFps: true, unstableWindow: 4, unstableMin: 2 };
    const at = (frames: number, freezes: number): StatsReportLike => ({
      forEach: (cb) =>
        cb({
          type: 'inbound-rtp',
          id: 'in',
          kind: 'video',
          framesDecoded: frames,
          packetsReceived: frames,
          packetsLost: 0,
          freezeCount: freezes,
          lastPacketReceivedTimestamp: frames,
        }),
    });
    const policy = new PlaybackPolicy(source(), 0, phone);
    policy.step(at(60, 0), 1000, { ...inputs, quality: 'f' });
    const results = [
      policy.step(at(70, 1), 2000, { ...inputs, quality: 'f' }).unstable,
      policy.step(at(75, 2), 3000, { ...inputs, quality: 'f' }).unstable,
    ];
    expect(results).toEqual([false, true]);
    let last = true;
    for (let i = 0; i < 4; i++) {
      last = policy.step(at(135 + i * 60, 2), 4000 + i * 1000, {
        ...inputs,
        quality: 'f',
      }).unstable;
    }
    expect(last).toBe(false);
  });

  it('starts Automatic on the middle layer on cellular', () => {
    const s = source();
    const policy = new PlaybackPolicy(s, 0);
    policy.step(report(60), 1000, { ...inputs, cellular: true });
    expect(s.calls).toEqual(['layer h']);
  });

  it('asks the source to pull again when the frames stop', () => {
    const s = source();
    const policy = new PlaybackPolicy(s, 0);
    policy.step(report(60), 1000, inputs);
    for (let t = 2000; t <= 7000; t += 1000) policy.step(report(60), t, inputs);
    expect(s.calls).toContain('retry');
  });
});

describe('brakes', () => {
  it('BackgroundPause suspends after the delay and resumes when watchable again', () => {
    const actions = { suspend: vi.fn(), resume: vi.fn() };
    const brake = new BackgroundPause(actions, 5000);
    brake.update(false);
    vi.advanceTimersByTime(4999);
    expect(actions.suspend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(actions.suspend).toHaveBeenCalledOnce();
    brake.update(true);
    expect(actions.resume).toHaveBeenCalledOnce();
  });

  it('IdleCheck asks, and stops watching without an answer', () => {
    const onTimeout = vi.fn();
    const onChange = vi.fn();
    const idle = new IdleCheck({ onChange, onTimeout }, 1000, 500);
    idle.start();
    vi.advanceTimersByTime(1000);
    expect(idle.state.kind).toBe('asking');
    idle.confirm();
    expect(idle.state.kind).toBe('watching');
    vi.advanceTimersByTime(1500);
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});
