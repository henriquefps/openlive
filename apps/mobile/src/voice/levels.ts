// SPDX-License-Identifier: AGPL-3.0-only
import type { LevelReader, StatsReportLike } from '@openlive/client';

// Who is speaking, on the phone: react-native-webrtc has no AnalyserNode, so the level of each
// voice comes from the session's stats (`audioLevel`, 0 to 1, of the inbound audio and of the
// microphone's media source), read a few times a second for all tracks at once and handed to the
// shared SampledLevelMonitor (packages/client voice/levels.ts), which does the gating and the hold.

/** The levels in a stats report, by the track's id (`trackIdentifier`). */
export function audioLevelsFromStats(stats: StatsReportLike): Map<string, number> {
  const levels = new Map<string, number>();
  stats.forEach((report) => {
    const r = report as {
      type?: string;
      kind?: string;
      trackIdentifier?: string;
      audioLevel?: number;
    };
    if (r.type !== 'inbound-rtp' && r.type !== 'media-source' && r.type !== 'track') return;
    if (r.kind !== undefined && r.kind !== 'audio') return;
    if (typeof r.trackIdentifier !== 'string' || typeof r.audioLevel !== 'number') return;
    levels.set(r.trackIdentifier, Math.max(levels.get(r.trackIdentifier) ?? 0, r.audioLevel));
  });
  return levels;
}

export interface StatsSource {
  getStats(): Promise<StatsReportLike>;
}

export interface Timers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** How often the session's stats are read while someone is listened to. */
export const STATS_INTERVAL_MS = 200;

/**
 * One getStats() for all the tracks: a reader asks the hub for its track's last level. The hub
 * polls only while a reader is open (voice off: nothing runs).
 */
export class StatsLevelHub {
  private levels = new Map<string, number>();
  private readers = 0;
  private timer: unknown = null;
  private reading = false;

  constructor(
    private readonly source: StatsSource,
    private readonly timers: Timers = {
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    },
    private readonly intervalMs: number = STATS_INTERVAL_MS,
  ) {}

  /** A reader of the level of the track with this id (`track.id`). */
  open(trackId: string): LevelReader {
    this.readers++;
    this.timer ??= this.timers.setInterval(() => void this.poll(), this.intervalMs);
    let closed = false;
    return {
      read: () => this.levels.get(trackId) ?? 0,
      close: () => {
        if (closed) return;
        closed = true;
        if (--this.readers > 0) return;
        if (this.timer !== null) this.timers.clearInterval(this.timer);
        this.timer = null;
        this.levels = new Map();
      },
    };
  }

  private async poll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      this.levels = audioLevelsFromStats(await this.source.getStats());
    } catch {
      // The session is between two peers: the levels stay as they were.
    } finally {
      this.reading = false;
    }
  }
}
