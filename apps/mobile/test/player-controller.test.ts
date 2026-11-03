// SPDX-License-Identifier: AGPL-3.0-only
import type { Layer, RoomState, SourceState, StatsReportLike } from '@openlive/client';
import { IDLE_ANSWER_MS, IDLE_MS, INITIAL_VOICE } from '@openlive/client';
import type { StreamInfo, ViewerMetricsRequest } from '@openlive/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RELEASE_AFTER_MS,
  SUSPEND_AFTER_MS,
  type WatchOptions,
  type WatchRoom,
  type WatchSource,
  WatchController,
} from '../src/player/controller.ts';

// The watch state machine: slot → source → live, the queue and full states, Automatic quality,
// and the app going to the background and coming back.

const STREAM: StreamInfo = {
  streamId: 'st_1',
  userId: 'u_ana',
  deviceId: 'd_1',
  source: { kind: 'window', label: 'Hades II' },
  preset: 'game',
  hasAudio: true,
  paused: false,
  startedAt: 0,
  viewerLimit: 6,
  viewerCount: 1,
};

const LAYERS: Layer[] = [
  { rid: 'f', height: 1080, fps: 60 },
  { rid: 'h', height: 720, fps: 60 },
  { rid: 'q', height: 480, fps: 30 },
];

class FakeRoom implements WatchRoom {
  state = {
    status: 'open',
    attempt: 0,
    you: null,
    room: null,
    settings: null,
    members: [{ userId: 'u_ana', displayName: 'Ana', role: 'member', canStream: true }],
    streams: [STREAM],
    viewers: {},
    access: {},
    endedStreams: {},
    expiresAt: null,
    ended: null,
    error: null,
    quotaExceeded: false,
    voice: INITIAL_VOICE,
  } as unknown as RoomState;
  private readonly listeners = new Set<() => void>();
  readonly calls: string[] = [];

  getState = () => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  watch = (id: string) => void this.calls.push(`watch ${id}`);
  unwatch = (id: string) => void this.calls.push(`unwatch ${id}`);
  joinQueue = (id: string) => void this.calls.push(`join ${id}`);
  leaveQueue = (id: string) => void this.calls.push(`leave ${id}`);
  acceptOffer = (id: string) => void this.calls.push(`accept ${id}`);

  set(patch: Partial<RoomState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }
  grant(slotId = 'sl_1'): void {
    this.set({
      access: {
        [STREAM.streamId]: { kind: 'granted', slotId, expiresAt: 0, leaseMs: 30_000 },
      },
    });
  }
}

class FakeSource implements WatchSource {
  state: SourceState = { kind: 'connecting' };
  layers: readonly Layer[] = [];
  layer: 'f' | 'h' | 'q' | null = null;
  codec = null;
  readonly calls: string[] = [];
  report: StatsReportLike = { forEach: () => undefined };
  private readonly listeners = new Set<() => void>();
  constructor(readonly slotId: string) {}
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  start = () => void this.calls.push('start');
  stop = () => void this.calls.push('stop');
  suspend = () => void this.calls.push('suspend');
  resume = () => void this.calls.push('resume');
  update = () => void this.calls.push('update');
  retry = () => void this.calls.push('retry');
  setLayer(rid: 'f' | 'h' | 'q') {
    this.calls.push(`layer ${rid}`);
    this.layer = rid;
    this.emit();
  }
  getStats = () => Promise.resolve(this.report);
  goLive(layer: 'f' | 'h' | 'q' = 'f') {
    this.state = { kind: 'live' };
    this.layers = LAYERS;
    this.layer = layer;
    this.emit();
  }
  private emit() {
    for (const l of [...this.listeners]) l();
  }
}

/** A report with one inbound video stream that decoded `frames` frames. */
const report = (frames: number): StatsReportLike => ({
  forEach: (cb) =>
    cb({
      type: 'inbound-rtp',
      id: 'in',
      kind: 'video',
      framesDecoded: frames,
      frameWidth: 1920,
      frameHeight: 1080,
      bytesReceived: frames * 1000,
      packetsReceived: frames,
      packetsLost: 0,
      lastPacketReceivedTimestamp: frames,
    }),
});

function first(): FakeSource {
  const source = sources[0];
  if (!source) throw new Error('no source was created');
  return source;
}

let room: FakeRoom;
let sources: FakeSource[];
let clock: number;

function controller(over: Partial<WatchOptions<FakeSource>> = {}) {
  return new WatchController<FakeSource>({
    room,
    streamId: STREAM.streamId,
    createSource: (_stream, slotId) => {
      const source = new FakeSource(slotId);
      sources.push(source);
      return source;
    },
    now: () => clock,
    ...over,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  room = new FakeRoom();
  sources = [];
  clock = 1_000;
});
afterEach(() => vi.useRealTimers());

describe('slot and source', () => {
  it('asks for the slot, waits for it, then pulls with the granted slot', () => {
    const c = controller();
    c.start();
    expect(room.calls).toEqual(['watch st_1']);
    expect(c.getSnapshot().screen).toBe('connecting');
    expect(sources).toHaveLength(0);

    room.grant('sl_1');
    expect(sources).toHaveLength(1);
    expect(sources[0]?.slotId).toBe('sl_1');
    expect(sources[0]?.calls).toEqual(['start']);

    sources[0]?.goLive();
    expect(c.getSnapshot().sourceState).toEqual({ kind: 'live' });
    expect(c.getSnapshot().layers).toEqual(LAYERS);
    expect(c.getSnapshot().ownerName).toBe('Ana');
  });

  it('keeps one source while the same slot is held and tells it about the stream', () => {
    const c = controller();
    c.start();
    room.grant('sl_1');
    room.set({ streams: [{ ...STREAM, paused: true }] });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.calls).toEqual(['start', 'update']);
    expect(c.getSnapshot().screen).toBe('paused');
  });

  it('pulls again with a new slot (after a reconnect) and stops the old source', () => {
    const c = controller();
    c.start();
    room.grant('sl_1');
    room.grant('sl_2');
    expect(sources.map((s) => s.slotId)).toEqual(['sl_1', 'sl_2']);
    expect(sources[0]?.calls).toContain('stop');
  });

  it('stops the source when the slot is gone', () => {
    const c = controller();
    c.start();
    room.grant();
    room.set({ access: {} });
    expect(sources[0]?.calls).toContain('stop');
    expect(c.getSnapshot().source).toBeNull();
  });

  it('close() stops the source and releases the slot', () => {
    const c = controller();
    c.start();
    room.grant();
    c.close();
    expect(sources[0]?.calls).toContain('stop');
    expect(room.calls).toEqual(['watch st_1', 'unwatch st_1']);
    expect(c.getSnapshot().closed).toBe(true);
    // Nothing reacts to the room any more.
    room.grant('sl_9');
    expect(sources).toHaveLength(1);
  });
});

describe('the queue and a full stream', () => {
  it('shows the full screen and the queue calls go to the room', () => {
    const c = controller();
    c.start();
    room.set({ access: { st_1: { kind: 'full', queue: null } } });
    expect(c.getSnapshot().screen).toBe('full');
    c.joinQueue();
    c.leaveQueue();
    expect(room.calls.slice(1)).toEqual(['join st_1', 'leave st_1']);
    room.set({ access: { st_1: { kind: 'offer', offerId: 'o1', expiresAt: 0 } } });
    expect(c.getSnapshot().screen).toBe('full');
    c.acceptOffer();
    expect(room.calls.at(-1)).toBe('accept st_1');
    room.grant();
    expect(sources).toHaveLength(1);
  });

  it('reports the viewers of the stream', () => {
    const c = controller();
    c.start();
    room.set({
      viewers: { st_1: { streamId: 'st_1', viewerUserIds: [], used: 6, limit: 6, queueLength: 2 } },
    });
    expect(c.getSnapshot().viewers).toEqual({ used: 6, limit: 6, queueLength: 2 });
  });

  it('shows no permission when the slot is denied', () => {
    const c = controller();
    c.start();
    room.set({ access: { st_1: { kind: 'denied', code: 'forbidden' } } });
    expect(c.getSnapshot().screen).toBe('noPermission');
  });

  it('shows the end of the stream', () => {
    const c = controller();
    c.start();
    room.grant();
    room.set({ streams: [], endedStreams: { st_1: 'ended_by_streamer' } });
    expect(c.getSnapshot().screen).toBe('ended');
    expect(sources[0]?.calls).toContain('stop');
  });
});

describe('the playback loop', () => {
  it('shows a first frame and the time it took', async () => {
    const c = controller();
    c.start();
    room.grant();
    const source = first();
    source.goLive();
    expect(c.getSnapshot().screen).toBe('connecting');

    source.report = report(0);
    await c.tick();
    expect(c.getSnapshot().firstFrame).toBe(false);

    clock = 1_850;
    source.report = report(30);
    await c.tick();
    expect(c.getSnapshot().firstFrame).toBe(true);
    expect(c.getSnapshot().ttffMs).toBe(850);
    expect(c.getSnapshot().screen).toBe('live');
    expect(c.getSnapshot().sample?.width).toBe(1920);
  });

  it('asks for a fixed layer and keeps asking for it once live', async () => {
    const c = controller();
    c.start();
    room.grant();
    const source = first();
    c.setQuality('q');
    expect(source.calls).not.toContain('layer q');
    source.goLive('f');
    expect(source.calls).toContain('layer q');
    source.layer = 'f'; // the source pulled again on the top layer
    source.report = report(10);
    await c.tick();
    expect(source.calls.filter((x) => x === 'layer q')).toHaveLength(2);
  });

  it('retries a stalled stream through the watchdog', async () => {
    const c = controller();
    c.start();
    room.grant();
    const source = first();
    source.goLive();
    source.report = report(10);
    await c.tick();
    for (let i = 0; i < 6; i++) {
      clock += 1000;
      await c.tick();
    }
    expect(source.calls).toContain('retry');
  });

  it('marks a muted track as paused after frames flowed', async () => {
    let muted = false;
    const c = controller({ isTrackMuted: () => muted });
    c.start();
    room.grant();
    const source = first();
    source.goLive();
    source.report = report(20);
    await c.tick();
    expect(c.getSnapshot().screen).toBe('live');
    muted = true;
    clock += 1000;
    source.report = report(20);
    await c.tick();
    expect(c.getSnapshot().screen).toBe('paused');
  });
});

describe('the app in the background', () => {
  it('stops the media after a few seconds and resumes it on return, keeping the slot', () => {
    const c = controller();
    c.start();
    room.grant();
    const source = first();
    source.goLive();
    c.setForeground(false);
    vi.advanceTimersByTime(SUSPEND_AFTER_MS - 1);
    expect(source.calls).not.toContain('suspend');
    vi.advanceTimersByTime(1);
    expect(source.calls).toContain('suspend');
    expect(c.getSnapshot().presence).toBe('suspended');

    c.setForeground(true);
    expect(source.calls).toContain('resume');
    expect(c.getSnapshot().presence).toBe('foreground');
    expect(room.calls).toEqual(['watch st_1']);
  });

  it('a quick trip to the background changes nothing', () => {
    const c = controller();
    c.start();
    room.grant();
    c.setForeground(false);
    vi.advanceTimersByTime(SUSPEND_AFTER_MS - 1);
    c.setForeground(true);
    vi.advanceTimersByTime(RELEASE_AFTER_MS);
    expect(sources[0]?.calls).toEqual(['start']);
  });

  it('gives the slot back after a minute away and asks for it again on return', () => {
    const c = controller();
    c.start();
    room.grant();
    c.setForeground(false);
    vi.advanceTimersByTime(RELEASE_AFTER_MS);
    expect(c.getSnapshot().presence).toBe('released');
    expect(room.calls).toEqual(['watch st_1', 'unwatch st_1']);
    expect(sources[0]?.calls).toContain('stop');
    expect(c.getSnapshot().source).toBeNull();

    // The room still lists the old slot until the release lands: no new source meanwhile.
    room.grant('sl_1');
    expect(sources).toHaveLength(1);

    room.set({ access: {} });
    c.setForeground(true);
    expect(c.getSnapshot().presence).toBe('foreground');
    expect(room.calls.at(-1)).toBe('watch st_1');
    room.grant('sl_2');
    expect(sources.map((s) => s.slotId)).toEqual(['sl_1', 'sl_2']);
  });

  it('ignores the background once closed', () => {
    const c = controller();
    c.start();
    c.close();
    c.setForeground(false);
    vi.advanceTimersByTime(RELEASE_AFTER_MS * 2);
    expect(room.calls).toEqual(['watch st_1', 'unwatch st_1']);
  });
});

describe('cellular connections and economy mode', () => {
  const live = async (c: ReturnType<typeof controller>) => {
    c.start();
    room.grant();
    const source = first();
    source.goLive('f');
    source.report = report(10);
    await c.tick();
    return source;
  };

  it('starts Automatic on the middle layer on cellular', async () => {
    const source = await live(controller({ cellular: () => true }));
    expect(source.calls).toContain('layer h');
  });

  it('starts Automatic on the top layer on wifi', async () => {
    const source = await live(controller({ cellular: () => false }));
    expect(source.calls.filter((x) => x.startsWith('layer'))).toEqual([]);
  });

  it('lets the viewer’s own pick win over cellular', async () => {
    const c = controller({ cellular: () => true });
    c.setQuality('f');
    const source = await live(c);
    expect(source.calls).not.toContain('layer h');
    expect(source.layer).toBe('f');
  });

  it('treats a stream with a quality cap as economy mode', async () => {
    room.set({ streams: [{ ...STREAM, qualityCap: { maxHeight: 720, maxBitrateKbps: 3000 } }] });
    const source = await live(controller());
    expect(source.calls).toContain('layer h');
  });
});

describe('the idle brake ("Still watching?")', () => {
  it('asks after the idle time, with the answer deadline', () => {
    const c = controller();
    c.start();
    room.grant();
    expect(c.getSnapshot().idle).toEqual({ kind: 'watching' });
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(c.getSnapshot().idle.kind).toBe('watching');
    vi.advanceTimersByTime(1);
    expect(c.getSnapshot().idle).toEqual({ kind: 'asking', deadline: clock + IDLE_ANSWER_MS });
  });

  it('lets the viewer keep watching and counts the idle time again', () => {
    const onIdleStop = vi.fn();
    const c = controller({ onIdleStop });
    c.start();
    room.grant();
    vi.advanceTimersByTime(IDLE_MS);
    c.confirmWatching();
    expect(c.getSnapshot().idle.kind).toBe('watching');
    vi.advanceTimersByTime(IDLE_ANSWER_MS * 2);
    expect(c.getSnapshot().idle.kind).toBe('watching');
    vi.advanceTimersByTime(IDLE_MS - IDLE_ANSWER_MS * 2);
    expect(c.getSnapshot().idle.kind).toBe('asking');
    expect(onIdleStop).not.toHaveBeenCalled();
  });

  it('releases the slot when nobody answers', () => {
    const onIdleStop = vi.fn();
    const c = controller({ onIdleStop });
    c.start();
    room.grant();
    vi.advanceTimersByTime(IDLE_MS + IDLE_ANSWER_MS);
    expect(onIdleStop).toHaveBeenCalledTimes(1);
    expect(room.calls).toEqual(['watch st_1', 'unwatch st_1']);
    expect(first().calls).toContain('stop');
    expect(c.getSnapshot().closed).toBe(true);
  });

  it('counts taps as activity, at most one restart per few seconds', () => {
    const c = controller();
    c.start();
    room.grant();
    vi.advanceTimersByTime(IDLE_MS - 1000);
    clock += IDLE_MS - 1000;
    c.activity();
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(c.getSnapshot().idle.kind).toBe('watching');
    vi.advanceTimersByTime(1);
    expect(c.getSnapshot().idle.kind).toBe('asking');
  });

  it('does not take a tap for the answer', () => {
    const c = controller();
    c.start();
    room.grant();
    vi.advanceTimersByTime(IDLE_MS);
    clock += 10_000;
    c.activity();
    expect(c.getSnapshot().idle.kind).toBe('asking');
  });

  it('can be turned off by the server', () => {
    const onIdleStop = vi.fn();
    const c = controller({ onIdleStop });
    c.start();
    room.grant();
    c.setIdleCheck(false);
    vi.advanceTimersByTime(IDLE_MS + IDLE_ANSWER_MS);
    expect(onIdleStop).not.toHaveBeenCalled();
    expect(c.getSnapshot().idle.kind).toBe('watching');
    c.setIdleCheck(true);
    vi.advanceTimersByTime(IDLE_MS);
    expect(c.getSnapshot().idle.kind).toBe('asking');
  });

  it('is not counted while the slot is released in the background', () => {
    const c = controller();
    c.start();
    room.grant();
    c.setForeground(false);
    vi.advanceTimersByTime(RELEASE_AFTER_MS);
    expect(c.getSnapshot().presence).toBe('released');
    vi.advanceTimersByTime(IDLE_MS + IDLE_ANSWER_MS);
    expect(c.getSnapshot().idle.kind).toBe('watching');
    expect(c.getSnapshot().closed).toBe(false);
  });
});

describe('playback metrics', () => {
  const setup = (windowMs = 30_000) => {
    const sent: { body: ViewerMetricsRequest; keepalive: boolean }[] = [];
    const c = controller({
      metrics: {
        roomId: 'r_1',
        windowMs,
        send: (body, keepalive) => sent.push({ body, keepalive }),
      },
    });
    return { c, sent };
  };

  it('posts first frame, layer and the window’s sums every window', async () => {
    const { c, sent } = setup();
    c.start();
    room.grant();
    const source = first();
    source.goLive('f');
    source.report = report(0);
    await c.tick();
    for (let i = 1; i <= 3; i++) {
      clock += 1000;
      source.report = report(i * 30);
      await c.tick();
    }
    clock += 27_000;
    vi.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(1);
    const { body, keepalive } = sent[0] ?? { body: null, keepalive: true };
    expect(keepalive).toBe(false);
    expect(body).toMatchObject({
      roomId: 'r_1',
      streamId: 'st_1',
      start: 'click',
      layer: 'f',
      ttffMs: 1000,
      reconnects: 0,
      decodeErrors: 0,
    });
    expect(body?.windowMs).toBe(30_000);
  });

  it('counts each trip into reconnecting', () => {
    const { c, sent } = setup();
    c.start();
    room.grant();
    const source = first();
    source.goLive();
    for (const attempt of [1, 2]) {
      source.state = { kind: 'reconnecting', attempt };
      source.setLayer('f');
    }
    source.state = { kind: 'live' };
    source.setLayer('f');
    source.state = { kind: 'reconnecting', attempt: 1 };
    source.setLayer('f');
    clock += 30_000;
    vi.advanceTimersByTime(30_000);
    expect(sent[0]?.body.reconnects).toBe(2);
  });

  it('sends the last, shorter window when the watch closes', async () => {
    const { c, sent } = setup();
    c.start();
    room.grant();
    const source = first();
    source.goLive('f');
    source.report = report(0);
    await c.tick();
    clock += 1000;
    source.report = report(30);
    await c.tick();
    clock += 4_000;
    c.close();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.keepalive).toBe(true);
    expect(sent[0]?.body).toMatchObject({ layer: 'f', windowMs: 5000 });
  });

  it('posts nothing for a watch that never got a sample', () => {
    const { c, sent } = setup();
    c.start();
    room.grant();
    clock += 10_000;
    c.close();
    expect(sent).toEqual([]);
  });

  it('posts nothing without a metrics sink', async () => {
    const c = controller();
    c.start();
    room.grant();
    const source = first();
    source.goLive();
    source.report = report(10);
    await c.tick();
    expect(() => c.close()).not.toThrow();
  });
});
