// SPDX-License-Identifier: AGPL-3.0-only
import type { MediaTrackLike, SpeakingMonitor } from './client.ts';

// Who is speaking, measured here from each voice's audio: a level
// read from each track ten times a second. Speaking starts above a level and ends after a short
// hold below it, so the ring does not flicker between words. Nothing is sent anywhere. Where the
// level comes from (an AnalyserNode in a browser, the stats of react-native-webrtc in the app) and
// the timers are the platform's.

/** RMS of the samples above which a voice counts as speaking (about -40 dBFS). */
export const SPEAKING_LEVEL = 0.01;
/** Below the level this long before speaking ends. */
export const SPEAKING_HOLD_MS = 400;
export const SAMPLE_INTERVAL_MS = 100;

/** The RMS of a block of samples (-1 to 1). */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

/** Turns a level reading into speaking or not, with the hold. */
export class SpeakingGate {
  speaking = false;
  private lastLoud = -Infinity;

  update(level: number, now: number): boolean {
    if (level >= SPEAKING_LEVEL) {
      this.lastLoud = now;
      this.speaking = true;
    } else if (this.speaking && now - this.lastLoud >= SPEAKING_HOLD_MS) {
      this.speaking = false;
    }
    return this.speaking;
  }
}

/** One track's level, 0 to 1 (an RMS), read on demand. */
export interface LevelReader {
  /** The level now. */
  read(): number;
  /** Releases what the reader holds. */
  close(): void;
}

/** The timers of the platform. */
export interface IntervalTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const GLOBAL_TIMERS: IntervalTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface LevelMonitorOptions<T extends MediaTrackLike> {
  onChange: (id: string, speaking: boolean) => void;
  /** Starts reading a track's level; null where the platform cannot (no speaking ring). */
  open: (track: T) => LevelReader | null;
  now?: () => number;
  timers?: IntervalTimers;
  intervalMs?: number;
}

interface Meter {
  reader: LevelReader;
  gate: SpeakingGate;
}

/** A SpeakingMonitor that samples each track's level on a timer and gates it. */
export class SampledLevelMonitor<T extends MediaTrackLike> implements SpeakingMonitor<T> {
  private readonly meters = new Map<string, Meter>();
  private timer: unknown = null;
  private readonly timers: IntervalTimers;
  private readonly now: () => number;

  constructor(private readonly options: LevelMonitorOptions<T>) {
    this.timers = options.timers ?? GLOBAL_TIMERS;
    this.now = options.now ?? (() => Date.now());
  }

  add(id: string, track: T): void {
    this.remove(id);
    const reader = this.options.open(track);
    if (!reader) return;
    this.meters.set(id, { reader, gate: new SpeakingGate() });
    this.timer ??= this.timers.setInterval(
      () => this.sample(),
      this.options.intervalMs ?? SAMPLE_INTERVAL_MS,
    );
  }

  remove(id: string): void {
    const meter = this.meters.get(id);
    if (!meter) return;
    this.meters.delete(id);
    meter.reader.close();
    if (meter.gate.speaking) this.options.onChange(id, false);
    if (this.meters.size === 0 && this.timer !== null) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    for (const id of [...this.meters.keys()]) this.remove(id);
  }

  private sample(): void {
    const now = this.now();
    for (const [id, meter] of this.meters) {
      const was = meter.gate.speaking;
      if (meter.gate.update(meter.reader.read(), now) !== was) this.options.onChange(id, !was);
    }
  }
}
