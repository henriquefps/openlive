// SPDX-License-Identifier: AGPL-3.0-only
// Stall watchdog (from app-share's viewer/watchdog.js): while frames should be arriving,
// `framesDecoded` must grow. When it stops for `stallMs`, ask the source to pull again, then wait
// longer before each next try (exponential backoff) until frames flow again. Pure: the player
// feeds it one reading per second.

export interface WatchdogOptions {
  /** No new frame for this long while active → stalled. */
  stallMs: number;
  /** Wait after the first retry; doubles per retry up to `maxBackoffMs`. */
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const WATCHDOG_DEFAULTS: WatchdogOptions = {
  stallMs: 4_000,
  baseBackoffMs: 2_000,
  maxBackoffMs: 30_000,
};

export interface WatchdogState {
  lastFrames: number;
  lastProgressAt: number;
  /** Retries since frames last flowed. */
  attempt: number;
  /** No retry before this time. */
  nextRetryAt: number;
}

export interface WatchdogReading {
  now: number;
  framesDecoded: number;
  /**
   * Frames are expected: the source is live, the stream is not paused and the track is not muted.
   * A paused stream sends nothing on purpose, which is not a stall.
   */
  active: boolean;
}

export function initialWatchdog(now: number): WatchdogState {
  return { lastFrames: 0, lastProgressAt: now, attempt: 0, nextRetryAt: 0 };
}

export function backoff(attempt: number, options: WatchdogOptions = WATCHDOG_DEFAULTS): number {
  return Math.min(options.maxBackoffMs, options.baseBackoffMs * 2 ** Math.max(0, attempt - 1));
}

export function stepWatchdog(
  state: WatchdogState,
  reading: WatchdogReading,
  options: WatchdogOptions = WATCHDOG_DEFAULTS,
): { state: WatchdogState; retry: boolean } {
  const { now, framesDecoded, active } = reading;
  if (framesDecoded > state.lastFrames) {
    return {
      state: { lastFrames: framesDecoded, lastProgressAt: now, attempt: 0, nextRetryAt: 0 },
      retry: false,
    };
  }
  // A retry starts a new RTP stream, whose counter starts over: a new baseline, not progress.
  const lastFrames = framesDecoded < state.lastFrames ? framesDecoded : state.lastFrames;
  if (!active) {
    // Waiting on purpose does not count towards a stall.
    return { state: { ...state, lastFrames, lastProgressAt: now }, retry: false };
  }
  if (now - state.lastProgressAt < options.stallMs || now < state.nextRetryAt) {
    return { state: { ...state, lastFrames }, retry: false };
  }
  const attempt = state.attempt + 1;
  return {
    state: { ...state, lastFrames, attempt, nextRetryAt: now + backoff(attempt, options) },
    retry: true,
  };
}
