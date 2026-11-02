// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  AUTO_DEFAULTS,
  type AutoState,
  initialAuto,
  judge,
  startLayer,
  stepAuto,
} from '../src/player/automatic.ts';
import type { Rid } from '../src/player/source.ts';
import { readStats, type StatsSample } from '../src/player/stats.ts';
import {
  backoff,
  initialWatchdog,
  stepWatchdog,
  type WatchdogState,
} from '../src/player/watchdog.ts';

const LAYERS: Rid[] = ['f', 'h', 'q'];

function sample(at: number, patch: Partial<StatsSample> = {}): StatsSample {
  return {
    at,
    width: 1920,
    height: 1080,
    fps: 60,
    bitrateBps: 8_000_000,
    loss: 0,
    newFreezes: 0,
    newFramesDropped: 0,
    newFramesDecoded: 60,
    jitterBufferMs: 12,
    rttMs: 30,
    codec: 'H264',
    decodeMs: 2,
    framesDecoded: at / 16,
    packetsLost: 0,
    freezeCount: 0,
    counters: {
      at,
      framesDecoded: 0,
      bytesReceived: 0,
      packetsReceived: 0,
      packetsLost: 0,
      freezeCount: 0,
      totalDecodeTime: 0,
      framesDropped: 0,
    },
    ...patch,
  };
}

/** Feeds one sample per second from `from` to `to` (exclusive) and returns the last state. */
function run(
  state: AutoState,
  from: number,
  to: number,
  patch: Partial<StatsSample>,
  nominalFps = 60,
): AutoState {
  let next = state;
  for (let at = from; at < to; at += 1000) {
    next = stepAuto(next, sample(at, patch), { layers: LAYERS, nominalFps });
  }
  return next;
}

describe('Automatic quality', () => {
  it('starts on the high layer, or the middle one on a cellular connection', () => {
    expect(startLayer(LAYERS, false)).toBe('f');
    expect(startLayer(LAYERS, true)).toBe('h');
    expect(startLayer(['f'], true)).toBe('f');
    expect(startLayer([], false)).toBeNull();
  });

  it('judges loss, freezes, slow decoding and low fps with loss as bad', () => {
    expect(judge(sample(0), 60)).toBe('good');
    expect(judge(sample(0, { fps: null }), 60)).toBe('neutral');
    expect(judge(sample(0, { loss: 0.06 }), 60)).toBe('bad');
    expect(judge(sample(0, { newFreezes: 1 }), 60)).toBe('bad');
    expect(judge(sample(0, { decodeMs: 15 }), 60)).toBe('bad');
    // Static screen content: few frames, no loss. Not a network problem.
    expect(judge(sample(0, { fps: 5 }), 60)).toBe('good');
    expect(judge(sample(0, { fps: 20, loss: 0.02 }), 60)).toBe('bad');
    expect(judge(sample(0, { loss: 0.03 }), 60)).toBe('neutral');
  });

  it('steps down one layer after a sustained bad stretch, not after a blip', () => {
    let state = initialAuto('f', 0);
    state = run(state, 5_000, 6_000, { loss: 0.2 });
    state = run(state, 6_000, 10_000, {});
    expect(state.layer).toBe('f');
    state = run(state, 10_000, 13_001, { loss: 0.2 });
    expect(state.layer).toBe('h');
    // The new layer settles before another decision, then the next step down follows.
    state = run(state, 13_001, 16_000, { loss: 0.2 });
    expect(state.layer).toBe('h');
    state = run(state, 16_000, 21_000, { loss: 0.2 });
    expect(state.layer).toBe('q');
    // Nothing below the low layer.
    state = run(state, 21_000, 40_000, { loss: 0.2 });
    expect(state.layer).toBe('q');
  });

  it('judges frames the decoder drops as bad, with no loss and a fast decode', () => {
    // A phone on the 120 fps layer: 90 decoded, 30 dropped a second.
    const phone = { fps: 90, newFramesDecoded: 90, newFramesDropped: 30 };
    expect(judge(sample(0, phone), 120)).toBe('bad');
    // A dropped frame or two (a keyframe's hiccup) is noise, but not good either.
    expect(judge(sample(0, { newFramesDropped: 2 }), 60)).toBe('neutral');
    expect(judge(sample(0, { newFramesDecoded: 600, newFramesDropped: 5 }), 60)).toBe('good');
    // Below 10 %: not bad, not yet good.
    expect(judge(sample(0, { newFramesDecoded: 100, newFramesDropped: 5 }), 120)).toBe('neutral');
  });

  it('steps down from the 120 fps layer when the decoder keeps dropping frames', () => {
    let state = initialAuto('f', 0);
    state = run(state, 4_000, 7_001, { fps: 80, newFramesDecoded: 80, newFramesDropped: 40 });
    expect(state.layer).toBe('h');
    // The 60 fps layer decodes cleanly: no further step down.
    state = run(state, 7_001, 12_000, {});
    expect(state.layer).toBe('h');
  });

  it('steps up after a stable stretch', () => {
    let state = initialAuto('q', 0);
    state = run(state, 4_000, 14_000, {});
    expect(state.layer).toBe('q');
    state = run(state, 14_000, 15_000, {});
    expect(state.layer).toBe('h');
    expect(state.lastClimbAt).toBe(14_000);
  });

  it('doubles the stable stretch after a failed climb, and resets it once a climb holds', () => {
    let state = initialAuto('h', 0);
    // Climb at 14 s (good from 4 s, 10 s base).
    state = run(state, 4_000, 15_000, {});
    expect(state.layer).toBe('f');
    // Bad again right away: back down, and the next climb needs 20 s.
    state = run(state, 15_000, 22_000, { loss: 0.2 });
    expect(state.layer).toBe('h');
    expect(state.upAfterMs).toBe(AUTO_DEFAULTS.upAfterMs * 2);
    state = run(state, 22_000, 41_000, {});
    expect(state.layer).toBe('h');
    state = run(state, 41_000, 43_000, {});
    expect(state.layer).toBe('f');
    // This climb holds past the failed-climb window: the base stretch is back.
    state = run(state, 43_000, 70_000, {});
    expect(state.layer).toBe('f');
    expect(state.upAfterMs).toBe(AUTO_DEFAULTS.upAfterMs);
  });

  it('caps the doubled stretch', () => {
    let state: AutoState = { ...initialAuto('h', 0), upAfterMs: AUTO_DEFAULTS.maxUpAfterMs };
    state = { ...state, layer: 'f', lastClimbAt: 0, lastSwitchAt: 0 };
    state = run(state, 5_000, 9_000, { loss: 0.2 });
    expect(state.layer).toBe('h');
    expect(state.upAfterMs).toBe(AUTO_DEFAULTS.maxUpAfterMs);
  });
});

describe('stall watchdog', () => {
  it('retries after 4 s without a new frame while frames are expected', () => {
    let state: WatchdogState = initialWatchdog(0);
    let retry: boolean;
    ({ state } = stepWatchdog(state, { now: 1_000, framesDecoded: 60, active: true }));
    for (const now of [2_000, 3_000, 4_000]) {
      ({ state, retry } = stepWatchdog(state, { now, framesDecoded: 60, active: true }));
      expect(retry).toBe(false);
    }
    ({ state, retry } = stepWatchdog(state, { now: 5_000, framesDecoded: 60, active: true }));
    expect(retry).toBe(true);
    expect(state.attempt).toBe(1);
  });

  it('backs off between retries until frames flow again', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((a) => backoff(a))).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    let state: WatchdogState = initialWatchdog(0);
    const retries: number[] = [];
    for (let now = 1_000; now <= 40_000; now += 1_000) {
      const step = stepWatchdog(state, { now, framesDecoded: 0, active: true });
      state = step.state;
      if (step.retry) retries.push(now);
    }
    expect(retries).toEqual([4_000, 6_000, 10_000, 18_000, 34_000]);
    // Frames again: everything resets.
    const step = stepWatchdog(state, { now: 41_000, framesDecoded: 30, active: true });
    expect(step.state).toEqual({
      lastFrames: 30,
      lastProgressAt: 41_000,
      attempt: 0,
      nextRetryAt: 0,
    });
  });

  it('does not count a paused stream or a muted track as a stall', () => {
    let state = initialWatchdog(0);
    for (let now = 1_000; now <= 20_000; now += 1_000) {
      const step = stepWatchdog(state, { now, framesDecoded: 10, active: false });
      state = step.state;
      expect(step.retry).toBe(false);
    }
    // Resuming gives the stream a full stall window again.
    expect(stepWatchdog(state, { now: 23_000, framesDecoded: 10, active: true }).retry).toBe(false);
    expect(stepWatchdog(state, { now: 24_000, framesDecoded: 10, active: true }).retry).toBe(true);
  });

  it('takes a counter that went back to zero (a new RTP stream) as the new baseline', () => {
    let state = stepWatchdog(initialWatchdog(0), {
      now: 1_000,
      framesDecoded: 500,
      active: true,
    }).state;
    state = stepWatchdog(state, { now: 2_000, framesDecoded: 0, active: true }).state;
    expect(state.lastFrames).toBe(0);
    expect(stepWatchdog(state, { now: 3_000, framesDecoded: 20, active: true }).state.attempt).toBe(
      0,
    );
  });
});

describe('readStats', () => {
  const report = (entries: (Record<string, unknown> & { type: string; id: string })[]) =>
    new Map(entries.map((e) => [e.id, e]));

  const at = (frames: number, bytes: number, received: number, lost: number) =>
    report([
      {
        id: 'v',
        type: 'inbound-rtp',
        kind: 'video',
        codecId: 'c',
        framesDecoded: frames,
        frameWidth: 1280,
        frameHeight: 720,
        bytesReceived: bytes,
        packetsReceived: received,
        packetsLost: lost,
        freezeCount: 1,
        totalDecodeTime: frames * 0.002,
        jitterBufferDelay: frames * 0.015,
        jitterBufferEmittedCount: frames,
      },
      { id: 'a', type: 'inbound-rtp', kind: 'audio', bytesReceived: 0 },
      { id: 'c', type: 'codec', mimeType: 'video/AV1' },
      { id: 'p', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.042 },
      { id: 'q', type: 'candidate-pair', nominated: false, currentRoundTripTime: 0.5 },
    ]);

  it('derives rates from the previous sample', () => {
    const first = readStats(at(100, 1_000_000, 900, 0), null, 1_000);
    expect(first.fps).toBeNull();
    expect(first.codec).toBe('AV1');
    expect(first.rttMs).toBeCloseTo(42);
    expect(first.jitterBufferMs).toBeCloseTo(15);
    const second = readStats(at(160, 2_000_000, 1_890, 10), first.counters, 2_000);
    expect(second.fps).toBe(60);
    expect(second.bitrateBps).toBe(8_000_000);
    expect(second.loss).toBeCloseTo(10 / 1_000);
    expect(second.decodeMs).toBeCloseTo(2);
    expect(second.newFreezes).toBe(0);
    expect(second.newFramesDecoded).toBe(60);
    expect([second.width, second.height]).toEqual([1280, 720]);
  });

  it('starts over when the counters reset (a retry)', () => {
    const first = readStats(at(1_000, 1_000_000, 900, 0), null, 1_000);
    expect(readStats(at(10, 10_000, 9, 0), first.counters, 2_000).fps).toBeNull();
  });

  it('follows the stream that got the last packet, not a frozen one with more frames', () => {
    const inbound = (id: string, frames: number, lastPacket: number) => ({
      id,
      type: 'inbound-rtp',
      kind: 'video',
      framesDecoded: frames,
      lastPacketReceivedTimestamp: lastPacket,
    });
    // A stopped receiver's report, frozen at 10 000 frames, next to the live pull's.
    const stale = inbound('old', 10_000, 5_000);
    const first = readStats(report([stale, inbound('new', 120, 61_000)]), null, 61_000);
    expect(first.framesDecoded).toBe(120);
    const second = readStats(report([stale, inbound('new', 240, 62_000)]), first.counters, 62_000);
    expect(second.framesDecoded).toBe(240);
    expect(second.fps).toBe(120);
    // Without timestamps (older browsers) the most frames still wins.
    const plain = readStats(
      report([
        { id: 'x', type: 'inbound-rtp', kind: 'video', framesDecoded: 5 },
        { id: 'y', type: 'inbound-rtp', kind: 'video', framesDecoded: 9 },
      ]),
      null,
      0,
    );
    expect(plain.framesDecoded).toBe(9);
  });
});
