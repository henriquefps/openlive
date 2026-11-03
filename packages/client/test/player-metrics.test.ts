// SPDX-License-Identifier: AGPL-3.0-only
import type { ViewerMetricsRequest } from '@openlive/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isCellularConnection, MetricsReporter, type StatsSample } from '../src/index.ts';

const sample = (at: number, over: Partial<StatsSample> = {}): StatsSample =>
  ({
    at,
    fps: 60,
    bitrateBps: 4_000_000,
    loss: 0.02,
    rttMs: 30,
    jitterBufferMs: 40,
    newFreezes: 0,
    newFramesDropped: 0,
    ...over,
  }) as StatsSample;

let now = 0;
beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000;
});
afterEach(() => vi.useRealTimers());

function reporter(sent: [ViewerMetricsRequest, boolean][]) {
  return new MetricsReporter({
    roomId: 'r_1',
    streamId: 'st_1',
    start: 'click',
    send: (body, keepalive) => sent.push([body, keepalive]),
    now: () => now,
    windowMs: 30_000,
  });
}

describe('MetricsReporter', () => {
  it('posts a window every windowMs with the sums, the layer and the first frame', () => {
    const sent: [ViewerMetricsRequest, boolean][] = [];
    const r = reporter(sent);
    r.begin();
    r.layer = 'h';
    r.firstFrame(820.4);
    for (let i = 1; i <= 3; i++) {
      now += 1000;
      r.add(sample(now, { newFreezes: i === 2 ? 1 : 0 }), true);
    }
    now += 27_000;
    vi.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(1);
    const [body, keepalive] = sent[0] ?? [];
    expect(keepalive).toBe(false);
    expect(body).toMatchObject({
      roomId: 'r_1',
      streamId: 'st_1',
      start: 'click',
      windowMs: 30_000,
      freezes: 1,
      fps: 60,
      bitrateKbps: 4000,
      lossPct: 2,
      ttffMs: 820,
      layer: 'h',
      rttMs: 30,
      jitterBufferMs: 40,
    });
  });

  it('sends the first frame once, and counts reconnects', () => {
    const sent: [ViewerMetricsRequest, boolean][] = [];
    const r = reporter(sent);
    r.begin();
    r.firstFrame(500);
    r.reconnect();
    now += 30_000;
    vi.advanceTimersByTime(30_000);
    r.firstFrame(700);
    r.reconnect();
    now += 30_000;
    vi.advanceTimersByTime(30_000);
    expect(sent[0]?.[0]).toMatchObject({ ttffMs: 500, reconnects: 1 });
    expect(sent[1]?.[0].ttffMs).toBeUndefined();
    expect(sent[1]?.[0].reconnects).toBe(1);
  });

  it('end() posts the last window with keepalive and stops the timer', () => {
    const sent: [ViewerMetricsRequest, boolean][] = [];
    const r = reporter(sent);
    r.begin();
    now += 1000;
    r.add(sample(now), true);
    now += 4000;
    r.end();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[1]).toBe(true);
    expect(sent[0]?.[0].windowMs).toBe(5000);
    now += 60_000;
    vi.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(1);
  });

  it('posts nothing for an empty or too-short window', () => {
    const sent: [ViewerMetricsRequest, boolean][] = [];
    const r = reporter(sent);
    r.begin();
    now += 30_000;
    vi.advanceTimersByTime(30_000);
    r.add(sample(now), false);
    now += 500;
    r.end();
    expect(sent).toEqual([]);
  });
});

describe('isCellularConnection', () => {
  it('knows the browser’s and expo-network’s names for cellular', () => {
    expect(isCellularConnection('cellular')).toBe(true);
    expect(isCellularConnection('CELLULAR')).toBe(true);
    for (const type of ['wifi', 'WIFI', 'ethernet', 'unknown', 'none', '', null, undefined]) {
      expect(isCellularConnection(type)).toBe(false);
    }
  });
});
