// SPDX-License-Identifier: AGPL-3.0-only
import type { ViewerMetricsRequest } from '@openlive/protocol';
import { type RefObject, useEffect, useRef } from 'react';
import {
  METRICS_WINDOW_MS,
  MIN_WINDOW_MS,
  MetricsWindow,
  type SourceState,
  type StatsSample,
  type WatchStart,
} from '@openlive/client';

// Playback metrics: the windows are @openlive/client's MetricsWindow; this posts them to
// POST /api/metrics/viewer (docs/PROTOCOL.md 11.3). One window per watched stream; the last,
// shorter one goes out with `keepalive` when the watch view closes.

export { METRICS_WINDOW_MS, MIN_WINDOW_MS, MetricsWindow, type WatchStart };

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
