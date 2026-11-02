// SPDX-License-Identifier: AGPL-3.0-only
import type { ViewerMetricsRequest } from '@openlive/protocol';
import { type RefObject, useEffect, useRef } from 'react';
import type { SourceState } from './source.ts';
import type { StatsSample } from './stats.ts';

// Playback metrics: the player's once-a-second stats samples, summed over about 30 s
// and posted to POST /api/metrics/viewer (docs/PROTOCOL.md 11.3), which writes them to Analytics
// Engine for the space status page. One window per watched stream; the last, shorter one goes out
// with `keepalive` when the watch view closes. Only ids and numbers leave the page.

export const METRICS_WINDOW_MS = 30_000;
/** A window shorter than this is not worth a post (a watch view opened and closed at once). */
export const MIN_WINDOW_MS = 1_000;

export type WatchStart = ViewerMetricsRequest['start'];

/** Sums of one window; pure, so tests feed it samples. */
export class MetricsWindow {
  private startedAt: number;
  private lastAt: number | null = null;
  private watchMs = 0;
  private samples = 0;
  private fpsSum = 0;
  private bitrateSum = 0;
  private lossSum = 0;
  private lossSamples = 0;
  private rttSum = 0;
  private rttSamples = 0;
  private jitterSum = 0;
  private jitterSamples = 0;
  private freezes = 0;
  private framesDropped = 0;
  private decodeErrors = 0;
  private reconnects = 0;
  private ttffMs: number | null = null;
  private ttffSent = false;

  constructor(now: number) {
    this.startedAt = now;
  }

  /** One stats sample; `live` means frames are expected (not paused, not reconnecting). */
  add(sample: StatsSample, live: boolean): void {
    const previous = this.lastAt;
    this.lastAt = sample.at;
    if (!live || sample.fps === null) return;
    this.samples += 1;
    if (sample.fps > 0 && previous !== null) this.watchMs += Math.max(0, sample.at - previous);
    this.fpsSum += sample.fps;
    this.bitrateSum += (sample.bitrateBps ?? 0) / 1000;
    if (sample.loss !== null) {
      this.lossSum += sample.loss * 100;
      this.lossSamples += 1;
    }
    if (sample.rttMs !== null) {
      this.rttSum += sample.rttMs;
      this.rttSamples += 1;
    }
    if (sample.jitterBufferMs !== null) {
      this.jitterSum += sample.jitterBufferMs;
      this.jitterSamples += 1;
    }
    this.freezes += sample.newFreezes;
    this.framesDropped += sample.newFramesDropped;
  }

  reconnect(): void {
    this.reconnects += 1;
  }

  decodeError(): void {
    this.decodeErrors += 1;
  }

  /** The first frame came, `ms` after the click; reported once per watch. */
  firstFrame(ms: number): void {
    if (!this.ttffSent) this.ttffMs = Math.round(ms);
  }

  /** The window's request, and a new window from `now`; null when there is nothing to say. */
  flush(
    now: number,
    ids: { roomId: string; streamId: string; start: WatchStart; layer: string | null },
  ): ViewerMetricsRequest | null {
    const windowMs = Math.round(now - this.startedAt);
    const empty =
      this.samples === 0 &&
      this.ttffMs === null &&
      this.reconnects === 0 &&
      this.decodeErrors === 0;
    if (windowMs < MIN_WINDOW_MS || empty) {
      if (windowMs >= MIN_WINDOW_MS) this.reset(now);
      return null;
    }
    const mean = (sum: number, n: number) => (n > 0 ? Math.round((sum / n) * 100) / 100 : 0);
    const request: ViewerMetricsRequest = {
      roomId: ids.roomId,
      streamId: ids.streamId,
      windowMs: Math.min(windowMs, 300_000),
      watchMs: Math.min(Math.round(this.watchMs), windowMs, 300_000),
      start: ids.start,
      freezes: this.freezes,
      fps: mean(this.fpsSum, this.samples),
      bitrateKbps: Math.round(this.bitrateSum / Math.max(1, this.samples)),
      lossPct: Math.min(100, mean(this.lossSum, this.lossSamples)),
      framesDropped: this.framesDropped,
      decodeErrors: this.decodeErrors,
      reconnects: this.reconnects,
      ...(this.ttffMs !== null ? { ttffMs: Math.min(this.ttffMs, 120_000) } : {}),
      ...(ids.layer ? { layer: ids.layer } : {}),
      ...(this.rttSamples > 0 ? { rttMs: mean(this.rttSum, this.rttSamples) } : {}),
      ...(this.jitterSamples > 0
        ? { jitterBufferMs: mean(this.jitterSum, this.jitterSamples) }
        : {}),
    };
    if (this.ttffMs !== null) this.ttffSent = true;
    this.reset(now);
    return request;
  }

  private reset(now: number): void {
    const { ttffSent } = this;
    Object.assign(this, new MetricsWindow(now));
    this.ttffSent = ttffSent;
  }
}

/** Sends one window; `keepalive` lets the last one outlive the page. Failures are dropped. */
export function postViewerMetrics(body: ViewerMetricsRequest, keepalive = false): void {
  void fetch('/api/metrics/viewer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive,
  }).catch(() => undefined);
}

export interface ViewerMetricsInput {
  /** Null turns reporting off (no room, the dev pages). */
  target: { roomId: string; streamId: string; start: WatchStart } | null;
  sample: StatsSample | null;
  state: SourceState | null;
  /** Frames are expected now. */
  live: boolean;
  layer: string | null;
  ttffMs: number | null;
  video: RefObject<HTMLVideoElement | null>;
  send?: (body: ViewerMetricsRequest, keepalive: boolean) => void;
  windowMs?: number;
}

/** Feeds the player's samples into windows and posts each one. */
export function useViewerMetrics({
  target,
  sample,
  state,
  live,
  layer,
  ttffMs,
  video,
  send = postViewerMetrics,
  windowMs = METRICS_WINDOW_MS,
}: ViewerMetricsInput): void {
  const current = useRef<MetricsWindow | null>(null);
  const latest = useRef({ layer, send });
  useEffect(() => {
    latest.current = { layer, send };
  });
  const roomId = target?.roomId ?? null;
  const streamId = target?.streamId ?? null;
  const start = target?.start ?? 'click';

  // One window series per watched stream; the last window is sent when it ends.
  useEffect(() => {
    if (roomId === null || streamId === null) return;
    const w = new MetricsWindow(performance.now());
    current.current = w;
    const flush = (keepalive: boolean) => {
      const body = w.flush(performance.now(), {
        roomId,
        streamId,
        start,
        layer: latest.current.layer,
      });
      if (body) latest.current.send(body, keepalive);
    };
    const timer = setInterval(() => flush(false), windowMs);
    const hide = () => flush(true);
    addEventListener('pagehide', hide);
    return () => {
      clearInterval(timer);
      removeEventListener('pagehide', hide);
      flush(true);
      if (current.current === w) current.current = null;
    };
  }, [roomId, streamId, start, windowMs]);

  useEffect(() => {
    if (sample) current.current?.add(sample, live);
    // Each sample once: `live` is read as it was when the sample came.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample]);

  const kind = state?.kind ?? null;
  useEffect(() => {
    if (kind === 'reconnecting') current.current?.reconnect();
  }, [kind]);

  useEffect(() => {
    if (ttffMs !== null) current.current?.firstFrame(ttffMs);
  }, [ttffMs]);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const error = () => current.current?.decodeError();
    element.addEventListener('error', error);
    return () => element.removeEventListener('error', error);
  }, [video]);
}
