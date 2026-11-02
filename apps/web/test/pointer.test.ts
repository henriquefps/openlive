// SPDX-License-Identifier: AGPL-3.0-only
import { PointerColor, PointerShape, type Message, type StreamInfo } from '@openlive/protocol';
import { describe, expect, it, vi } from 'vitest';
import { elementPercent, frameBox, framePoint } from '../src/pointer/geometry.ts';
import { helperMayPing, pingsIntent } from '../src/pointer/intent.ts';
import { PING_BURST, pointerSocket, type PointerRejection } from '../src/pointer/socket.ts';
import {
  DEFAULT_POINTER_STYLE,
  loadPointerStyle,
  POINTER_COLORS,
  POINTER_SHAPES,
  PointerStyleStore,
} from '../src/pointer/style.ts';

// Visual pointer pings on the web side (docs/PROTOCOL.md 7.9): where a click lands on the frame,
// the pointer style, the socket's rate limit and errors, and "Allow visual clicks" from Go live.

describe('frame geometry (object-contain letterboxing)', () => {
  it('pillarboxes a 4:3 frame in a 16:9 player and maps clicks over the frame only', () => {
    const box = { width: 1600, height: 900 };
    // 1200×900 frame, centred: 200 px bars left and right.
    expect(frameBox(box, 1024, 768)).toEqual({ left: 200, top: 0, width: 1200, height: 900 });
    expect(framePoint(200, 0, box, 1024, 768)).toEqual({ x: 0, y: 0 });
    expect(framePoint(800, 450, box, 1024, 768)).toEqual({ x: 0.5, y: 0.5 });
    expect(framePoint(1400, 900, box, 1024, 768)).toEqual({ x: 1, y: 1 });
    // On the bars: not on the streamer's screen.
    expect(framePoint(100, 450, box, 1024, 768)).toBeNull();
    expect(framePoint(1500, 450, box, 1024, 768)).toBeNull();
  });

  it('letterboxes an ultrawide frame with bars on top and bottom', () => {
    const box = { width: 1600, height: 900 };
    // 3440×1440 scaled to 1600 wide: 669.77 px tall, bars of 115.1 px.
    const frame = frameBox(box, 3440, 1440);
    expect(frame.width).toBe(1600);
    expect(frame.height).toBeCloseTo(669.77, 1);
    expect(frame.top).toBeCloseTo(115.12, 1);
    expect(framePoint(400, 50, box, 3440, 1440)).toBeNull();
    expect(framePoint(400, 880, box, 3440, 1440)).toBeNull();
    const p = framePoint(400, 450, box, 3440, 1440);
    expect(p?.x).toBeCloseTo(0.25);
    expect(p?.y).toBeCloseTo(0.5);
    // And back to the element, to place the local marker.
    const at = elementPercent({ x: 0.25, y: 0 }, box, 3440, 1440);
    expect(at.left).toBeCloseTo(25);
    expect(at.top).toBeCloseTo((115.12 / 900) * 100, 1);
  });

  it('uses the whole element before the frame size is known', () => {
    const box = { width: 800, height: 450 };
    expect(framePoint(400, 225, box, 0, 0)).toEqual({ x: 0.5, y: 0.5 });
    expect(framePoint(10, 10, { width: 0, height: 0 }, 0, 0)).toBeNull();
  });
});

describe('pointer style', () => {
  it('copies the closed lists of the protocol', () => {
    expect([...POINTER_COLORS].sort()).toEqual(Object.values(PointerColor).sort());
    expect([...POINTER_SHAPES].sort()).toEqual(Object.values(PointerShape).sort());
  });

  it('defaults to an olive ring and ignores unknown or broken values', () => {
    const store = (raw: string | null) => ({ getItem: () => raw, setItem: () => undefined });
    expect(DEFAULT_POINTER_STYLE).toEqual({ color: 'olive', shape: 'ring' });
    expect(loadPointerStyle(store(null))).toEqual(DEFAULT_POINTER_STYLE);
    expect(loadPointerStyle(store('{'))).toEqual(DEFAULT_POINTER_STYLE);
    expect(loadPointerStyle(store('{"color":"black","shape":"star"}'))).toEqual({
      color: 'olive',
      shape: 'star',
    });
  });

  it('saves a change and tells the subscribers', () => {
    const saved = new Map<string, string>();
    const backing = {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
    };
    const store = new PointerStyleStore(() => backing);
    const listener = vi.fn();
    store.subscribe(listener);
    store.update({ color: 'cyan' });
    expect(store.get()).toEqual({ color: 'cyan', shape: 'ring' });
    expect(listener).toHaveBeenCalledOnce();
    expect(loadPointerStyle(backing)).toEqual({ color: 'cyan', shape: 'ring' });
  });
});

/** A room socket that records requests and lets the test answer them. */
function fakeTransport() {
  const sent: { id: string; type: string; payload: object }[] = [];
  const listeners = new Set<(m: Message) => void>();
  let next = 0;
  return {
    sent,
    transport: {
      listen: (l: (m: Message) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      sendRequest: (type: string, payload: object) => {
        const id = String(++next);
        sent.push({ id, type, payload });
        return id;
      },
    },
    receive: (message: Message) => {
      for (const l of listeners) l(message);
    },
  };
}

describe('pointer socket', () => {
  const STYLE = { color: 'olive', shape: 'ring' } as const;

  it('sends pointer.ping and stream.setPings', () => {
    const fake = fakeTransport();
    const socket = pointerSocket(fake.transport, () => 0);
    expect(socket.ping('st_1', 0.25, 0.5, STYLE)).toBe(true);
    socket.setPings('st_1', true);
    expect(fake.sent.map(({ type, payload }) => ({ type, payload }))).toEqual([
      { type: 'pointer.ping', payload: { streamId: 'st_1', x: 0.25, y: 0.5, style: STYLE } },
      { type: 'stream.setPings', payload: { streamId: 'st_1', enabled: true } },
    ]);
  });

  it('holds back clicks beyond the burst, then refills at 4 per second', () => {
    const fake = fakeTransport();
    let now = 1_000;
    const socket = pointerSocket(fake.transport, () => now);
    const rejected: PointerRejection[] = [];
    socket.onRejected((r) => rejected.push(r));
    for (let i = 0; i < PING_BURST; i++) expect(socket.ping('st_1', 0, 0, STYLE)).toBe(true);
    expect(socket.ping('st_1', 0, 0, STYLE)).toBe(false);
    expect(rejected).toEqual([{ kind: 'rate_limited', retryAfterMs: 250 }]);
    expect(fake.sent).toHaveLength(PING_BURST);
    now += 250;
    expect(socket.ping('st_1', 0, 0, STYLE)).toBe(true);
  });

  it("stays quiet until the room's retryAfterMs after rate_limited", () => {
    const fake = fakeTransport();
    let now = 0;
    const socket = pointerSocket(fake.transport, () => now);
    const rejected: PointerRejection[] = [];
    socket.onRejected((r) => rejected.push(r));
    socket.ping('st_1', 0, 0, STYLE);
    const id = fake.sent[0]?.id ?? '';
    fake.receive({
      type: 'error',
      id,
      payload: { code: 'rate_limited', retryAfterMs: 2_000 },
    } as Message);
    expect(rejected).toEqual([{ kind: 'rate_limited', retryAfterMs: 2_000 }]);
    now = 1_000;
    expect(socket.ping('st_1', 0, 0, STYLE)).toBe(false);
    now = 2_001;
    expect(socket.ping('st_1', 0, 0, STYLE)).toBe(true);
  });

  it("reports its own requests' errors only", () => {
    const fake = fakeTransport();
    const socket = pointerSocket(fake.transport, () => 0);
    const rejected: PointerRejection[] = [];
    socket.onRejected((r) => rejected.push(r));
    socket.setPings('st_1', true);
    socket.ping('st_1', 0, 0, STYLE);
    const [setId, pingId] = fake.sent.map((s) => s.id);
    fake.receive({ type: 'error', id: '99', payload: { code: 'forbidden' } } as Message);
    fake.receive({ type: 'error', id: setId, payload: { code: 'forbidden' } } as Message);
    fake.receive({
      type: 'error',
      id: pingId,
      payload: { code: 'pings_disabled', streamId: 'st_1' },
    } as Message);
    expect(rejected).toEqual([
      { kind: 'setPings', error: { code: 'forbidden' } },
      { kind: 'ping', error: { code: 'pings_disabled', streamId: 'st_1' } },
    ]);
  });
});

describe('Allow visual clicks from Go live', () => {
  const stream = (patch: Partial<StreamInfo>): StreamInfo => ({
    streamId: 'st_1',
    userId: 'u_ana',
    deviceId: 'd_pc',
    source: { kind: 'screen', label: 'Screen' },
    preset: 'game',
    hasAudio: false,
    paused: false,
    startedAt: 0,
    viewerLimit: 6,
    viewerCount: 0,
    ...patch,
  });

  it('is offered for helpers of protocol 1.20 and up, not on macOS', () => {
    const v = (minor: number) => ({ major: 1, minor });
    expect(helperMayPing({ os: 'linux', protocol: v(20) })).toBe(true);
    expect(helperMayPing({ os: 'windows', protocol: v(21) })).toBe(true);
    expect(helperMayPing({ os: 'linux', protocol: v(19) })).toBe(false);
    expect(helperMayPing({ os: 'macos', protocol: v(20) })).toBe(false);
    expect(helperMayPing(undefined)).toBe(false);
  });

  it("applies once to the user's stream from that helper, only when it can draw", () => {
    pingsIntent.set('rm_1', 'd_pc', true);
    // Not this user's, or not yet in the room: the choice waits.
    expect(pingsIntent.due('rm_1', 'u_ana', [stream({ userId: 'u_bo' })])).toEqual([]);
    expect(pingsIntent.has('rm_1', 'd_pc')).toBe(true);
    const s = stream({ pingOverlay: true });
    expect(pingsIntent.due('rm_1', 'u_ana', [s])).toEqual([s]);
    expect(pingsIntent.due('rm_1', 'u_ana', [s])).toEqual([]);

    // A helper that cannot draw: dropped silently.
    pingsIntent.set('rm_1', 'd_pc', true);
    expect(pingsIntent.due('rm_1', 'u_ana', [stream({})])).toEqual([]);
    expect(pingsIntent.has('rm_1', 'd_pc')).toBe(false);
  });
});
