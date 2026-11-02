// SPDX-License-Identifier: AGPL-3.0-only
import { type RefObject, useEffect, useState } from 'react';

// The viewer's screen, for stats for nerds: how often it refreshes and how
// many video frames it presents. A 60 Hz screen shows at most 60 of a 120 fps layer's frames, so
// the overlay says so. Measured only while the overlay is open.

export interface DisplayCadence {
  /** The screen's refresh rate: requestAnimationFrame runs once per refresh. */
  screenHz: number | null;
  /** Video frames presented per second (requestVideoFrameCallback's presentedFrames). */
  presentedFps: number | null;
}

/** The refresh rate from frame intervals: the median, so a skipped frame or a slow one does not count. */
export function refreshHzFrom(intervalsMs: readonly number[]): number | null {
  const valid = intervalsMs.filter((ms) => ms > 0 && ms < 100);
  if (valid.length < 10) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return median > 0 ? 1000 / median : null;
}

/**
 * The refresh rate to name when the screen is what caps the frame rate: the stream arrives clearly
 * faster than the screen refreshes (a 120 fps layer on a 60 Hz screen). Null otherwise.
 */
export function screenLimit(receivedFps: number | null, screenHz: number | null): number | null {
  if (receivedFps === null || screenHz === null) return null;
  return receivedFps > screenHz * 1.1 ? Math.round(screenHz) : null;
}

/** Measures the screen's refresh and the presented video frame rate once a second while `enabled`. */
export function useDisplayCadence(
  video: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
): DisplayCadence {
  const [cadence, setCadence] = useState<DisplayCadence>({ screenHz: null, presentedFps: null });
  useEffect(() => {
    if (!enabled) return;
    const el = video.current;
    // Older Firefox has no requestVideoFrameCallback: the presented rate stays unknown there.
    const vfcSupported = !!el && typeof el.requestVideoFrameCallback === 'function';
    let raf = 0;
    let vfc = 0;
    let last: number | null = null;
    let intervals: number[] = [];
    const onFrame = (now: number) => {
      if (last !== null) intervals.push(now - last);
      if (intervals.length > 240) intervals = intervals.slice(-240);
      last = now;
      raf = requestAnimationFrame(onFrame);
    };
    raf = requestAnimationFrame(onFrame);

    let presented: { at: number; frames: number } | null = null;
    let presentedFps: number | null = null;
    const onVideoFrame: VideoFrameRequestCallback = (now, metadata) => {
      if (presented && now - presented.at >= 1000) {
        presentedFps =
          ((metadata.presentedFrames - presented.frames) * 1000) / (now - presented.at);
        presented = { at: now, frames: metadata.presentedFrames };
      } else if (!presented) {
        presented = { at: now, frames: metadata.presentedFrames };
      }
      if (el && vfcSupported) vfc = el.requestVideoFrameCallback(onVideoFrame);
    };
    if (el && vfcSupported) vfc = el.requestVideoFrameCallback(onVideoFrame);

    const timer = setInterval(() => {
      setCadence({ screenHz: refreshHzFrom(intervals), presentedFps });
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      if (el && vfcSupported && vfc) el.cancelVideoFrameCallback(vfc);
      clearInterval(timer);
    };
  }, [video, enabled]);
  return enabled ? cadence : { screenHz: null, presentedFps: null };
}
