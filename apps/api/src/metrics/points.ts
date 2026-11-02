// SPDX-License-Identifier: AGPL-3.0-only
// Metrics as Workers Analytics Engine data points (docs/observability.md). One dataset,
// `openlive_metrics`; every point has the same shape so one SQL query can read them all:
//
//   index1  the space id ('instance' when there is none), the sampling key
//   blob1   the kind: viewer | helper | stream | error
//   blob2   space id, blob3 room id, blob4 stream id (empty when not known)
//   blob5…  and double1… per kind, as the layouts below list them
//
// Only ids go in, never names, e-mail addresses or IPs. A missing binding (a self-host that
// removed it) turns every write into nothing.

import type { HelperStatsPayload, ViewerMetricsRequest } from '@openlive/protocol';

export type MetricKind = 'viewer' | 'helper' | 'stream' | 'error';

/** Where a point belongs. */
export interface MetricScope {
  spaceId: string | null;
  roomId?: string | null;
  streamId?: string | null;
}

/**
 * The doubles of each kind, in order (double1 first). The status queries (status.ts) and
 * docs/observability.md read them by these positions.
 */
export const VIEWER_DOUBLES = [
  'windowS',
  'watchS',
  'ttffMs',
  'hasTtff',
  'freezes',
  'fps',
  'bitrateKbps',
  'lossPct',
  'framesDropped',
  'decodeErrors',
  'reconnects',
  'rttMs',
  'jitterBufferMs',
] as const;
/** blob5: layer, blob6: start (click | prepull). */

export const HELPER_DOUBLES = [
  'windowS',
  'samples',
  'capturedFps',
  'sentFps',
  'targetKbps',
  'sentKbps',
  'cpuPct',
  'lossPct',
  'rttMs',
  'keyframeRequests',
  'idrMaxBytes',
] as const;
/** blob5: encoder. */

export const STREAM_DOUBLES = ['durationS', 'dropped'] as const;
/** blob5: end reason. */

export const ERROR_DOUBLES = ['status'] as const;
/** blob5: method, blob6: error code. */

const INSTANCE = 'instance';

/** The binding as the code sees it: optional, so a deploy without it still runs. */
export type MetricsDataset = Pick<AnalyticsEngineDataset, 'writeDataPoint'> | undefined;

/**
 * The dataset to write to. With METRICS_LOG=1 every point is also logged (`metrics {...}` in
 * Workers Logs or the `wrangler dev` terminal): `wrangler dev` keeps Analytics Engine writes
 * local and unreadable, so this is how to watch them arrive.
 */
export function metricsDataset(env: {
  METRICS?: AnalyticsEngineDataset | undefined;
  METRICS_LOG?: string | undefined;
}): MetricsDataset {
  const dataset = env.METRICS as MetricsDataset;
  if (env.METRICS_LOG !== '1') return dataset;
  return {
    writeDataPoint(point) {
      console.log(`metrics ${JSON.stringify(point)}`);
      dataset?.writeDataPoint(point);
    },
  };
}

export function writePoint(
  dataset: MetricsDataset,
  kind: MetricKind,
  scope: MetricScope,
  extraBlobs: readonly string[],
  doubles: readonly number[],
): void {
  if (!dataset) return;
  const spaceId = scope.spaceId ?? '';
  try {
    dataset.writeDataPoint({
      indexes: [spaceId || INSTANCE],
      blobs: [kind, spaceId, scope.roomId ?? '', scope.streamId ?? '', ...extraBlobs],
      doubles: doubles.map((d) => (Number.isFinite(d) ? d : 0)),
    });
  } catch (error) {
    // Metrics never fail a request (the 250 points per invocation limit, a bad value).
    console.warn('metrics: write failed', error);
  }
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/** The request body after validation (optional fields may be present as undefined). */
export type ViewerMetrics = {
  [K in keyof ViewerMetricsRequest]: ViewerMetricsRequest[K] | undefined;
} & Pick<
  ViewerMetricsRequest,
  | 'windowMs'
  | 'watchMs'
  | 'start'
  | 'freezes'
  | 'fps'
  | 'bitrateKbps'
  | 'lossPct'
  | 'framesDropped'
  | 'decodeErrors'
  | 'reconnects'
>;

export function writeViewer(dataset: MetricsDataset, scope: MetricScope, m: ViewerMetrics): void {
  writePoint(
    dataset,
    'viewer',
    scope,
    [m.layer ?? '', m.start],
    [
      m.windowMs / 1000,
      m.watchMs / 1000,
      m.ttffMs ?? 0,
      m.ttffMs === undefined ? 0 : 1,
      m.freezes,
      round(m.fps),
      Math.round(m.bitrateKbps),
      round(m.lossPct, 3),
      m.framesDropped,
      m.decodeErrors,
      m.reconnects,
      Math.round(m.rttMs ?? 0),
      round(m.jitterBufferMs ?? 0),
    ],
  );
}

export function writeStreamEnd(
  dataset: MetricsDataset,
  scope: MetricScope,
  reason: string,
  durationMs: number,
): void {
  // A helper that vanished is the "dropped stream" of the metrics; every other reason was chosen.
  const dropped = reason === 'helper_disconnected' ? 1 : 0;
  writePoint(dataset, 'stream', scope, [reason], [Math.max(0, durationMs) / 1000, dropped]);
}

export function writeError(
  dataset: MetricsDataset,
  spaceId: string | null,
  method: string,
  code: string,
  status: number,
): void {
  writePoint(dataset, 'error', { spaceId }, [method, code], [status]);
}

/**
 * The helper's ~1 s helper.stats reports of one stream, summed until the hub writes them as one
 * point (every HELPER_WINDOW_MS).
 */
export interface HelperWindow {
  startedAt: number;
  samples: number;
  encoder: string;
  capturedFps: number;
  capturedSamples: number;
  sentFps: number;
  targetKbps: number;
  sentKbps: number;
  cpuPct: number;
  cpuSamples: number;
  lossPct: number;
  rttMs: number;
  keyframeRequests: number;
  idrMaxBytes: number;
}

export const HELPER_WINDOW_MS = 30_000;

export function emptyHelperWindow(now: number): HelperWindow {
  return {
    startedAt: now,
    samples: 0,
    encoder: '',
    capturedFps: 0,
    capturedSamples: 0,
    sentFps: 0,
    targetKbps: 0,
    sentKbps: 0,
    cpuPct: 0,
    cpuSamples: 0,
    lossPct: 0,
    rttMs: 0,
    keyframeRequests: 0,
    idrMaxBytes: 0,
  };
}

export function addHelperSample(w: HelperWindow, s: HelperStatsPayload): void {
  w.samples += 1;
  if (s.encoder) w.encoder = s.encoder;
  if (s.capturedFps !== undefined) {
    w.capturedFps += s.capturedFps;
    w.capturedSamples += 1;
  }
  if (s.cpuPct !== undefined) {
    w.cpuPct += s.cpuPct;
    w.cpuSamples += 1;
  }
  w.sentFps += s.fps;
  w.targetKbps += s.targetBitrateKbps;
  w.sentKbps += s.sentBitrateKbps;
  w.lossPct += s.packetLossPct;
  w.rttMs += s.rttMs;
  w.keyframeRequests += s.keyframeRequests ?? 0;
  w.idrMaxBytes = Math.max(w.idrMaxBytes, s.idrBytes ?? 0);
}

export function writeHelper(
  dataset: MetricsDataset,
  scope: MetricScope,
  w: HelperWindow,
  now: number,
): void {
  if (w.samples === 0) return;
  const mean = (sum: number, n = w.samples) => (n > 0 ? round(sum / n) : 0);
  writePoint(
    dataset,
    'helper',
    scope,
    [w.encoder],
    [
      (now - w.startedAt) / 1000,
      w.samples,
      mean(w.capturedFps, w.capturedSamples),
      mean(w.sentFps),
      Math.round(w.targetKbps / w.samples),
      Math.round(w.sentKbps / w.samples),
      mean(w.cpuPct, w.cpuSamples),
      mean(w.lossPct),
      Math.round(w.rttMs / w.samples),
      w.keyframeRequests,
      w.idrMaxBytes,
    ],
  );
}
