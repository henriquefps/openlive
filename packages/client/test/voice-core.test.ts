// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ApiClient,
  CAMERA_ENCODINGS,
  CameraClient,
  type CameraMedia,
  cameraConstraints,
  clampPersonVolume,
  createCameraApi,
  createVoiceApi,
  type DeviceInfoLike,
  type DevicesLike,
  findVoiceSinkDevice,
  type IntervalTimers,
  type MediaTrackLike,
  micConstraints,
  micErrorOf,
  NetworkMeter,
  type Publication,
  qualityOf,
  RoomSession,
  type RoomSessionParts,
  rms,
  SampledLevelMonitor,
  type SignalVoice,
  SpeakingGate,
  type VoiceMedia,
  VoiceClient,
  type VoiceOutput,
  type VoiceSignal,
  VoiceSessions,
} from '../src/index.ts';

// The voice and camera clients with no DOM: plain-object tracks, devices, speakers and timers, as
// the app's react-native-webrtc binding hands them over.

class Track implements MediaTrackLike {
  enabled = true;
  stopped = false;
  private readonly ended: (() => void)[] = [];
  constructor(readonly id: string) {}
  stop() {
    this.stopped = true;
  }
  addEventListener(_type: 'ended', listener: () => void) {
    this.ended.push(listener);
  }
  unplug() {
    for (const listener of this.ended) listener();
  }
}

class Signal implements VoiceSignal {
  voice: SignalVoice = {
    self: 'out',
    selfId: 'me',
    canSpeak: true,
    participants: [],
    tracks: [],
    cameras: [],
    canUseCamera: true,
    cameraStopped: null,
    error: null,
    left: null,
  };
  sent: { type: string; payload?: unknown }[] = [];
  private readonly listeners = new Set<() => void>();
  getVoice = () => this.voice;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  join(state: { muted: boolean; deafened: boolean }) {
    this.sent.push({ type: 'join', payload: state });
    this.update({ self: 'joining' });
  }
  leave() {
    this.sent.push({ type: 'leave' });
    this.update({ self: 'out', tracks: [], left: 'left' });
  }
  setState(state: { muted: boolean; deafened: boolean }) {
    this.sent.push({ type: 'state', payload: state });
  }
  update(patch: Partial<SignalVoice>) {
    this.voice = { ...this.voice, ...patch };
    for (const listener of this.listeners) listener();
  }
  admit(others: string[] = []) {
    this.update({
      self: 'in',
      participants: ['me', ...others].map((userId) => ({
        userId,
        muted: false,
        deafened: false,
        serverMuted: false,
        joinedAt: 0,
      })),
    });
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function publication(): Publication<Track> & { replaced: (Track | null)[]; layers: string[][] } {
  const replaced: (Track | null)[] = [];
  const layers: string[][] = [];
  return {
    sessionId: 's1',
    mid: '1',
    replaced,
    layers,
    replaceTrack: (t) => {
      replaced.push(t);
      return Promise.resolve();
    },
    setActiveLayers: (active) => {
      layers.push(['h', 'l'].filter(active));
      return Promise.resolve();
    },
  };
}

function setupVoice(options: { canSpeak?: boolean } = {}) {
  const signal = new Signal();
  signal.voice.canSpeak = options.canSpeak ?? true;
  const publications: ReturnType<typeof publication>[] = [];
  const media = {
    publish: vi.fn<VoiceMedia<Track>['publish']>(() => {
      const p = publication();
      publications.push(p);
      return Promise.resolve(p);
    }),
    unpublish: vi.fn<VoiceMedia<Track>['unpublish']>(() => Promise.resolve()),
    pull: vi.fn<VoiceMedia<Track>['pull']>((tracks) =>
      Promise.resolve(new Map(tracks.map((t) => [t.trackId, new Track(`r-${t.userId}`)]))),
    ),
    unpull: vi.fn<VoiceMedia<Track>['unpull']>(() => Promise.resolve()),
    onReset: () => () => undefined,
  } satisfies VoiceMedia<Track>;
  const mics: Track[] = [];
  let failure: Error | null = null;
  const devices = {
    getUserMedia: vi.fn<DevicesLike<Track>['getUserMedia']>(() => {
      if (failure) return Promise.reject(failure);
      const t = new Track(`mic-${mics.length + 1}`);
      mics.push(t);
      return Promise.resolve({
        getAudioTracks: () => [t],
        getVideoTracks: () => [],
        getTracks: () => [t],
      });
    }),
    enumerateDevices: () =>
      Promise.resolve<DeviceInfoLike[]>([
        { deviceId: 'mic-a', kind: 'audioinput', label: 'Headset' },
        { deviceId: 'spk-a', kind: 'audiooutput', label: 'Speakers' },
      ]),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } satisfies DevicesLike<Track>;
  const playing = new Map<string, number>();
  const output = {
    canPickSink: false,
    attach: (id: string, _t: Track, volume: number) => playing.set(id, volume),
    detach: (id: string) => playing.delete(id),
    setVolume: (id: string, volume: number) => playing.set(id, volume),
    setDeafened: vi.fn(),
    setSink: () => Promise.resolve(false),
    resume: vi.fn(),
    dispose: vi.fn(),
  } satisfies VoiceOutput<Track>;
  const volumes = new Map<string, number>();
  let speak: (id: string, speaking: boolean) => void = () => undefined;
  const client = new VoiceClient<Track>({
    signal,
    media,
    devices,
    output,
    createMonitor: (onChange) => {
      speak = onChange;
      return { add: () => undefined, remove: () => undefined, dispose: () => undefined };
    },
    prefs: {
      inputId: '',
      outputId: '',
      pushToTalk: false,
      pushToTalkKey: 'KeyV',
      headphonesHintDismissed: false,
    },
    savePrefs: () => undefined,
    loadVolume: (id) => volumes.get(id) ?? 1,
    saveVolume: (id, v) => volumes.set(id, v),
  });
  client.start();
  return {
    client,
    signal,
    media,
    publications,
    mics,
    playing,
    output,
    speak: (id: string, speaking: boolean) => speak(id, speaking),
    fail: (error: Error | null) => {
      failure = error;
    },
  };
}

describe('VoiceClient without a DOM', () => {
  it('joins: microphone first, then the room, then the SFU, and pulls the others', async () => {
    const t = setupVoice();
    await t.client.join();
    expect(t.signal.sent[0]).toEqual({ type: 'join', payload: { muted: false, deafened: false } });
    t.signal.update({ tracks: [{ userId: 'ana', trackId: 'tr_ana' }] });
    t.signal.admit(['ana']);
    await flush();
    expect(t.client.getState().phase).toBe('joined');
    expect(t.media.publish).toHaveBeenCalledWith(t.mics[0]);
    expect(t.media.pull).toHaveBeenCalledOnce();
    expect(t.playing.get('ana')).toBe(1);
    expect(t.client.getState().transmitting).toBe(true);
  });

  it('mute only switches the track off; deafen mutes and gives the old mute back', async () => {
    const t = setupVoice();
    await t.client.join();
    t.signal.admit();
    await flush();
    const mic = t.mics[0] as Track;
    t.client.setMuted(true);
    expect(mic.enabled).toBe(false);
    expect(t.media.publish).toHaveBeenCalledOnce();
    t.client.setDeafened(true);
    expect(t.output.setDeafened).toHaveBeenLastCalledWith(true);
    t.client.setDeafened(false);
    expect(t.client.getState().muted).toBe(true);
    t.client.setMuted(false);
    expect(mic.enabled).toBe(true);
  });

  it('unmuting while deafened lifts deafen too', async () => {
    const t = setupVoice();
    await t.client.join();
    t.signal.admit();
    t.client.setDeafened(true);
    t.client.setMuted(false);
    expect(t.client.getState()).toMatchObject({ deafened: false, muted: false });
  });

  it('push-to-talk transmits only while the key (or button) is held', async () => {
    const t = setupVoice();
    await t.client.join();
    t.signal.admit();
    await flush();
    t.client.setPushToTalk(true);
    expect(t.client.getState().transmitting).toBe(false);
    t.client.setPttPressed(true);
    expect(t.client.getState().transmitting).toBe(true);
    t.client.setPttPressed(false);
    expect((t.mics[0] as Track).enabled).toBe(false);
  });

  it('a server mute drops the publication and lifting it publishes again', async () => {
    const t = setupVoice();
    await t.client.join();
    t.signal.admit();
    await flush();
    t.signal.update({
      participants: [
        { userId: 'me', muted: false, deafened: false, serverMuted: true, joinedAt: 0 },
      ],
    });
    await flush();
    expect(t.media.unpublish).toHaveBeenCalledOnce();
    expect(t.client.getState()).toMatchObject({ serverMuted: true, transmitting: false });
    t.signal.update({
      participants: [
        { userId: 'me', muted: false, deafened: false, serverMuted: false, joinedAt: 0 },
      ],
    });
    await flush();
    expect(t.media.publish).toHaveBeenCalledTimes(2);
  });

  it('per-person volume is clamped, remembered and applied to the speakers', async () => {
    const t = setupVoice();
    await t.client.join();
    t.signal.update({ tracks: [{ userId: 'ana', trackId: 'tr_ana' }] });
    t.signal.admit(['ana']);
    await flush();
    t.client.setVolume('ana', 5);
    expect(t.client.getState().volumes.ana).toBe(2);
    expect(t.playing.get('ana')).toBe(2);
    expect(clampPersonVolume(-1)).toBe(0);
    expect(clampPersonVolume(Number.NaN)).toBe(1);
  });

  it('your own ring follows the monitor only while transmitting', async () => {
    const t = setupVoice();
    await t.client.join();
    t.signal.admit();
    await flush();
    t.speak('self', true);
    expect(t.client.getState().speaking.me).toBe(true);
    t.client.setMuted(true);
    expect(t.client.getState().speaking.me).toBe(false);
  });

  it('errors are told by name, so any WebRTC library fits', async () => {
    expect(micErrorOf(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toBe('denied');
    expect(micErrorOf({ name: 'NotFoundError' })).toBe('no_device');
    expect(micErrorOf(null)).toBe('failed');
    const t = setupVoice();
    t.fail(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
    await t.client.join();
    expect(t.client.getState().micError).toBe('denied');
    expect(micConstraints('x')).toMatchObject({ audio: { deviceId: { exact: 'x' } } });
  });

  it('an unplugged microphone leaves the person listening and tries the default', async () => {
    const t = setupVoice();
    await t.client.join();
    t.signal.admit();
    await flush();
    (t.mics[0] as Track).unplug();
    await flush();
    expect(t.mics).toHaveLength(2);
    expect(t.client.getState().micError).toBeNull();
  });

  it('leaving closes the microphone and the pulls', async () => {
    const t = setupVoice();
    await t.client.join();
    t.signal.update({ tracks: [{ userId: 'ana', trackId: 'tr_ana' }] });
    t.signal.admit(['ana']);
    await flush();
    t.client.leave();
    expect((t.mics[0] as Track).stopped).toBe(true);
    expect(t.media.unpull).toHaveBeenCalled();
    expect(t.client.getState().phase).toBe('idle');
  });

  it('someone who may not speak joins without the microphone', async () => {
    const t = setupVoice({ canSpeak: false });
    await t.client.join();
    expect(t.mics).toHaveLength(0);
    expect(t.signal.sent[0]?.type).toBe('join');
  });
});

describe('speaking math', () => {
  it('rms of samples', () => {
    expect(rms([])).toBe(0);
    expect(rms([1, -1, 1, -1])).toBe(1);
    expect(rms(new Float32Array([0.5, 0.5]))).toBeCloseTo(0.5);
  });

  it('the gate holds speaking for 400 ms below the level', () => {
    const gate = new SpeakingGate();
    expect(gate.update(0.5, 0)).toBe(true);
    expect(gate.update(0, 300)).toBe(true);
    expect(gate.update(0, 400)).toBe(false);
  });

  it('the sampled monitor reads each track on the platform timers', () => {
    let level = 0.5;
    let tick: () => void = () => undefined;
    const cleared: unknown[] = [];
    const timers: IntervalTimers = {
      setInterval: (callback) => {
        tick = callback;
        return 'h';
      },
      clearInterval: (handle) => cleared.push(handle),
    };
    const changes: [string, boolean][] = [];
    let closed = 0;
    let now = 0;
    const monitor = new SampledLevelMonitor<Track>({
      onChange: (id, speaking) => changes.push([id, speaking]),
      open: () => ({ read: () => level, close: () => closed++ }),
      timers,
      now: () => now,
    });
    monitor.add('ana', new Track('t'));
    tick();
    expect(changes).toEqual([['ana', true]]);
    level = 0;
    now = 500;
    tick();
    expect(changes.at(-1)).toEqual(['ana', false]);
    monitor.remove('ana');
    expect(closed).toBe(1);
    expect(cleared).toEqual(['h']);
  });

  it('no level source, no ring', () => {
    const monitor = new SampledLevelMonitor<Track>({ onChange: () => undefined, open: () => null });
    monitor.add('ana', new Track('t'));
    monitor.dispose();
  });
});

describe('network quality', () => {
  it('worsens at once and recovers one step after three good samples', () => {
    expect(qualityOf({ lossPct: 0, rttMs: null })).toBe('good');
    expect(qualityOf({ lossPct: 4, rttMs: 10 })).toBe('poor');
    expect(qualityOf({ lossPct: 0, rttMs: 900 })).toBe('bad');
    const meter = new NetworkMeter();
    expect(meter.update({ lossPct: 20, rttMs: 0 })).toBe('bad');
    const good = { lossPct: 0, rttMs: 10 };
    expect(meter.update(good)).toBe('bad');
    expect(meter.update(good)).toBe('bad');
    expect(meter.update(good)).toBe('poor');
  });

  it('samples loss between two readings', () => {
    const meter = new NetworkMeter();
    const stats = (lost: number, received: number) => ({
      forEach: (cb: (r: Record<string, unknown> & { type: string; id: string }) => void) => {
        cb({ type: 'inbound-rtp', id: 'i', packetsLost: lost, packetsReceived: received });
        cb({
          type: 'candidate-pair',
          id: 'p',
          state: 'succeeded',
          nominated: true,
          currentRoundTripTime: 0.2,
        });
      },
    });
    meter.sample(stats(0, 100));
    expect(meter.sample(stats(10, 190))).toEqual({ lossPct: 10, rttMs: 200 });
  });
});

describe('CameraClient without a DOM', () => {
  function setup() {
    const signal = new Signal();
    signal.admit(['ana']);
    signal.update({
      tracks: [{ userId: 'ana', trackId: 'tr_ana' }],
      cameras: [{ userId: 'ana', trackId: 'cam_ana', rids: ['h', 'l'] }],
    });
    const pub = publication();
    const layerCalls: [string, string][] = [];
    const media = {
      publish: vi.fn(() => Promise.resolve(pub)),
      unpublish: vi.fn(() => Promise.resolve()),
      drop: vi.fn(() => Promise.resolve()),
      pull: vi.fn((cameras: readonly { trackId: string }[]) =>
        Promise.resolve(new Map(cameras.map((c) => [c.trackId, new Track(c.trackId)]))),
      ),
      unpull: vi.fn(() => Promise.resolve()),
      setLayer: vi.fn((trackId: string, rid: string) => {
        layerCalls.push([trackId, rid]);
        return Promise.resolve();
      }),
      link: vi.fn(),
      onReset: () => () => undefined,
    } satisfies CameraMedia<Track>;
    const devices = {
      getUserMedia: vi.fn(() => {
        const t = new Track('cam');
        return Promise.resolve({
          getAudioTracks: () => [],
          getVideoTracks: () => [t],
          getTracks: () => [t],
        });
      }),
      enumerateDevices: () => Promise.resolve([]),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } satisfies DevicesLike<Track>;
    const client = new CameraClient<Track>({
      signal,
      media,
      devices,
      prefs: { inputId: '', facing: 'user' },
      savePrefs: () => undefined,
    });
    client.start();
    return { client, media, pub, layerCalls };
  }

  it('publishes with the two simulcast layers and sends both on a good network', async () => {
    const t = setup();
    await t.client.turnOn();
    expect(t.client.getState().phase).toBe('on');
    expect(CAMERA_ENCODINGS.map((e) => e.rid)).toEqual(['h', 'l']);
    expect(cameraConstraints('', 'user')).toMatchObject({ audio: false });
    expect(t.pub.layers.at(-1)).toEqual(['h', 'l']);
  });

  it('pulls the others on the low layer and enlarges to the high one', async () => {
    const t = setup();
    await flush();
    expect(t.media.link).toHaveBeenCalledWith([{ video: 'cam_ana', audio: 'tr_ana' }]);
    expect(Object.keys(t.client.getState().remote)).toEqual(['ana']);
    t.client.enlarge('ana');
    expect(t.layerCalls).toEqual([['cam_ana', 'h']]);
    t.client.setNetwork('poor');
    expect(t.layerCalls.at(-1)).toEqual(['cam_ana', 'l']);
  });

  it('a poor network sends the low layer only, a bad one pauses and stops pulling', async () => {
    const t = setup();
    await t.client.turnOn();
    t.client.setNetwork('poor');
    await flush();
    expect(t.pub.layers.at(-1)).toEqual(['l']);
    t.client.setNetwork('bad');
    await flush();
    expect(t.pub.layers.at(-1)).toEqual([]);
    expect(t.client.getState().remote).toEqual({});
  });

  it('the device going away turns the camera off with device_lost', async () => {
    const t = setup();
    await t.client.turnOn();
    (t.client.getState().preview as Track).unplug();
    expect(t.client.getState()).toMatchObject({ phase: 'off', error: 'device_lost' });
  });
});

describe('RoomSession without a DOM', () => {
  afterEach(() => vi.restoreAllMocks());

  function parts(canVoice: boolean) {
    const listeners = new Set<() => void>();
    const roomState = {
      status: 'open',
      room: { name: 'Sala' },
      settings: {
        capabilities: { stream: true, voice: canVoice, camera: canVoice, text: false },
      },
      voice: { left: null },
      ended: null,
    };
    const voiceState = { phase: 'idle', removed: null };
    const calls: string[] = [];
    const p = {
      connection: {
        getState: () => roomState,
        subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
        start: () => calls.push('connection.start'),
        stop: () => calls.push('connection.stop'),
        reconnect: () => calls.push('reconnect'),
      },
      rtc: {
        getStatus: () => 'idle',
        subscribe: () => () => undefined,
        start: () => calls.push('rtc.start'),
        close: () => calls.push('rtc.close'),
        getStats: () => Promise.resolve({ forEach: () => undefined }),
      },
      voice: {
        getState: () => voiceState,
        subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
        start: () => calls.push('voice.start'),
        stop: () => calls.push('voice.stop'),
        join: () => Promise.resolve(),
        leave: () => undefined,
      },
      camera: {
        getState: () => ({}),
        subscribe: () => () => undefined,
        start: () => calls.push('camera.start'),
        stop: () => calls.push('camera.stop'),
        setNetwork: (n: string) => calls.push(`network.${n}`),
      },
      signal: new Signal(),
    };
    return { p: p as unknown as RoomSessionParts, calls, voiceState, listeners };
  }

  it('starts the media the room settings call for and stops it all on stop()', () => {
    const t = parts(true);
    const session = new RoomSession({
      roomId: 'r1',
      parts: t.p,
      fake: false,
      window: null,
      createMeter: () => ({ sample: () => ({ lossPct: 0, rttMs: null }), update: () => 'good' }),
    });
    session.start();
    expect(t.calls).toEqual(['connection.start', 'rtc.start', 'voice.start', 'camera.start']);
    session.stop();
    expect(t.calls.slice(4)).toEqual(['camera.stop', 'voice.stop', 'rtc.close', 'connection.stop']);
  });

  it('opens the SFU session only while in voice when asked to (the phone app)', async () => {
    const t = parts(true);
    const session = new RoomSession({
      roomId: 'r1',
      parts: t.p,
      fake: false,
      window: null,
      rtc: 'voice',
      createMeter: () => ({ sample: () => ({ lossPct: 0, rttMs: null }), update: () => 'good' }),
    });
    session.start();
    // Voice is on offer, the socket and the clients run, but nothing connects to the SFU yet.
    expect(t.calls).toEqual(['connection.start', 'voice.start', 'camera.start']);
    t.voiceState.phase = 'joining';
    for (const l of t.listeners) l();
    expect(t.calls.at(-1)).toBe('rtc.start');
    t.voiceState.phase = 'idle';
    for (const l of t.listeners) l();
    await flush();
    expect(t.calls.at(-1)).toBe('rtc.close');
    session.stop();
  });

  it('reads the SFU stats on the platform timers while in voice with cameras', async () => {
    const t = parts(true);
    let tick: () => void = () => undefined;
    const timers: IntervalTimers = {
      setInterval: (callback) => ((tick = callback), 'h'),
      clearInterval: vi.fn(),
    };
    const session = new RoomSession({
      roomId: 'r1',
      parts: t.p,
      fake: false,
      window: null,
      timers,
      createMeter: () => ({ sample: () => ({ lossPct: 20, rttMs: 0 }), update: () => 'bad' }),
    });
    session.start();
    t.voiceState.phase = 'joined';
    for (const l of t.listeners) l();
    tick();
    await flush();
    expect(t.calls).toContain('network.bad');
    session.stop();
    expect(timers.clearInterval).toHaveBeenCalledWith('h');
  });

  it('keeps one room in voice at a time and holds a room while it is in voice', () => {
    const a = parts(true);
    const b = parts(true);
    const make = (id: string, p: RoomSessionParts) =>
      new RoomSession({
        roomId: id,
        parts: p,
        fake: true,
        window: null,
        createMeter: () => ({ sample: () => ({ lossPct: 0, rttMs: null }), update: () => 'good' }),
      });
    const sessions = new VoiceSessions(() => make('x', a.p));
    const sa = make('r1', a.p);
    const sb = make('r2', b.p);
    const release = sessions.view(sa);
    a.voiceState.phase = 'joined';
    for (const l of a.listeners) l();
    expect(sessions.getState().active).toBe(sa);
    sessions.requestJoin(sb);
    expect(sessions.getState().pendingSwitch).toEqual({ from: sa, to: sb });
    sessions.cancelSwitch();
    release();
    // Still held by the voice.
    expect(sa.isStarted).toBe(true);
    sessions.dispose();
    expect(sa.isStarted).toBe(false);
  });
});

describe('routes and the voice sink', () => {
  it('voice and camera routes go through the API client', async () => {
    const calls: unknown[][] = [];
    const client = {
      send: (...args: unknown[]) => (calls.push(args), Promise.resolve(undefined)),
    } as unknown as ApiClient;
    await createVoiceApi(client, 'r 1').unsubscribe('s1', ['t1']);
    await createVoiceApi(client, 'r 1').unpublish('s1');
    await createCameraApi(client, 'r1').layer('s1', 't1', 'h');
    expect(calls).toEqual([
      ['POST', '/api/rtc/rooms/r%201/voice/unsubscribe', { sessionId: 's1', trackIds: ['t1'] }],
      ['POST', '/api/rtc/rooms/r%201/voice/unpublish', { sessionId: 's1' }],
      ['PUT', '/api/rtc/rooms/r1/camera/layer', { sessionId: 's1', trackId: 't1', rid: 'h' }],
    ]);
  });

  it('finds the voice sink by label, with or without a suffix', () => {
    const out = (deviceId: string, label: string) => ({ deviceId, label, kind: 'audiooutput' });
    expect(findVoiceSinkDevice([out('a', 'Sink')], 'Sink')).toBe('a');
    expect(findVoiceSinkDevice([out('a', 'Sink (Virtual)')], 'Sink')).toBe('a');
    expect(findVoiceSinkDevice([out('default', 'Sink')], 'Sink')).toBeNull();
    expect(findVoiceSinkDevice([out('a', 'Sink')], ' ')).toBeNull();
  });
});
