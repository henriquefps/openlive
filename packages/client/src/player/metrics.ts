// SPDX-License-Identifier: AGPL-3.0-only
import type { ViewerMetricsRequest } from '@openlive/protocol';
import type { StatsSample } from './stats.ts';

// Playback metrics: the player's once-a-second stats samples, summed over about 30 s
// and posted to POST /api/metrics/viewer (docs/PROTOCOL.md 11.3), which writes them to Analytics
// Engine for the space status page. Only ids and numbers leave the device.

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

/** Where a window goes: the web posts it with fetch, the app with its API client. */
export type MetricsSink = (body: ViewerMetricsRequest, keepalive: boolean) => void;

export interface MetricsReporterOptions {
  roomId: string;
  streamId: string;
  start: WatchStart;
  send: MetricsSink;
  /** The clock, in ms; the same one that stamps the stats samples. */
  now: () => number;
  windowMs?: number;
}

/**
 * One watched stream's metrics: samples go into windows of `windowMs`, each posted when it ends,
 * and the last, shorter one when the watch stops. The web keeps its hook (it ties the windows to
 * the document); the app's controller uses this class.
 */
export class MetricsReporter {
  layer: string | null = null;
  private window: MetricsWindow;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: MetricsReporterOptions) {
    this.window = new MetricsWindow(options.now());
  }

  begin(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.flush(false), this.options.windowMs ?? METRICS_WINDOW_MS);
  }

  add(sample: StatsSample, live: boolean): void {
    this.window.add(sample, live);
  }

  reconnect(): void {
    this.window.reconnect();
  }

  firstFrame(ms: number): void {
    this.window.firstFrame(ms);
  }

  /** The last window goes out and the reporter stops. */
  end(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.flush(true);
  }

  private flush(keepalive: boolean): void {
    const { roomId, streamId, start, send, now } = this.options;
    const body = this.window.flush(now(), { roomId, streamId, start, layer: this.layer });
    if (body) send(body, keepalive);
  }
}
