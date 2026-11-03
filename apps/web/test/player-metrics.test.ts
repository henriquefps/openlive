// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { MetricsWindow } from '../src/player/metrics.ts';
import type { StatsSample } from '@openlive/client';

// The player's metrics window: one-second stats samples summed into the ~30 s body of
// POST /api/metrics/viewer.

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

const IDS = { roomId: 'rm_1', streamId: 'st_1', start: 'click' as const, layer: 'f' };

describe('MetricsWindow', () => {
  it('sums a window of samples into one request', () => {
    const w = new MetricsWindow(0);
    w.add(sample(1_000, { fps: null, bitrateBps: null, loss: null }), true);
    for (let at = 2_000; at <= 30_000; at += 1_000) {
      w.add(
        sample(at, {
          fps: at === 10_000 ? 0 : 60,
          loss: at === 20_000 ? 0.1 : 0,
          newFreezes: at === 10_000 ? 1 : 0,
          newFramesDropped: 1,
        }),
        true,
      );
    }
    w.firstFrame(412.4);
    w.reconnect();
    const body = w.flush(30_000, IDS);
    expect(body).toMatchObject({
      roomId: 'rm_1',
      streamId: 'st_1',
      windowMs: 30_000,
      // 29 one-second steps, one of them without frames.
      watchMs: 28_000,
      ttffMs: 412,
      start: 'click',
      layer: 'f',
      freezes: 1,
      framesDropped: 29,
      decodeErrors: 0,
      reconnects: 1,
      bitrateKbps: 8_000,
      rttMs: 30,
      jitterBufferMs: 12,
    });
    expect(body?.fps).toBeCloseTo((60 * 28) / 29, 1);
    expect(body?.lossPct).toBeCloseTo(10 / 29, 2);
  });

  it('reports the first frame once per watch', () => {
    const w = new MetricsWindow(0);
    w.add(sample(1_000), true);
    w.add(sample(2_000), true);
    w.firstFrame(300);
    expect(w.flush(30_000, IDS)?.ttffMs).toBe(300);
    w.firstFrame(900);
    w.add(sample(31_000), true);
    w.add(sample(32_000), true);
    expect(w.flush(60_000, IDS)?.ttffMs).toBeUndefined();
  });

  it('counts no watch time while frames are not expected (paused, reconnecting)', () => {
    const w = new MetricsWindow(0);
    for (let at = 1_000; at <= 10_000; at += 1_000) w.add(sample(at), false);
    expect(w.flush(10_000, IDS)).toBeNull();
  });

  it('sends nothing for an empty or tiny window, then starts a new one', () => {
    const w = new MetricsWindow(0);
    expect(w.flush(500, IDS)).toBeNull();
    expect(w.flush(30_000, IDS)).toBeNull();
    w.add(sample(31_000), true);
    w.add(sample(32_000), true);
    expect(w.flush(60_000, IDS)?.windowMs).toBe(30_000);
  });

  it('leaves out what it does not know', () => {
    const w = new MetricsWindow(0);
    w.add(sample(1_000, { rttMs: null, jitterBufferMs: null }), true);
    w.add(sample(2_000, { rttMs: null, jitterBufferMs: null }), true);
    const body = w.flush(30_000, { ...IDS, layer: null, start: 'prepull' });
    expect(body).not.toHaveProperty('rttMs');
    expect(body).not.toHaveProperty('jitterBufferMs');
    expect(body).not.toHaveProperty('layer');
    expect(body?.start).toBe('prepull');
  });

  it('a decode error alone is worth a report', () => {
    const w = new MetricsWindow(0);
    w.decodeError();
    w.reconnect();
    expect(w.flush(30_000, IDS)).toMatchObject({ decodeErrors: 1, reconnects: 1, watchMs: 0 });
  });
});
