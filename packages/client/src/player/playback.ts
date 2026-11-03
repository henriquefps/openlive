// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AutoOptions,
  AUTO_DEFAULTS,
  type AutoState,
  initialAuto,
  judge,
  startLayer,
  stepAuto,
} from './automatic.ts';
import type { PlayerSource, Rid, StatsReportLike } from './source.ts';
import { readStats, type StatsCounters, type StatsSample } from './stats.ts';
import { initialWatchdog, stepWatchdog, type WatchdogState } from './watchdog.ts';

// What the player does once a second while it has a source: read the stats,
// feed the stall watchdog (a stall → the source pulls again, with backoff) and, on Automatic, the
// layer policy. Platform-free: the web's usePlaybackLoop and the app's player call `step` with the
// report they fetched, and render what it returns.

/** The viewer's quality choice: Automatic, or one fixed layer. */
export type Quality = 'auto' | Rid;

export interface PlaybackInputs {
  quality: Quality;
  /** Frames are expected now (live, not paused, track not muted). */
  active: boolean;
  /** Economy mode caps the stream: Automatic starts on the middle layer. */
  economy: boolean;
  /** A cellular connection: Automatic starts on the middle layer too. */
  cellular: boolean;
}

export class PlaybackPolicy {
  private counters: StatsCounters | null = null;
  private watchdog: WatchdogState;
  private auto: AutoState | null = null;
  private start: Rid | null = null;
  private recent: boolean[] = [];

  constructor(
    private readonly source: PlayerSource,
    now: number,
    /** Platform overrides of the Automatic policy (the app turns the decode-time check off). */
    private readonly options: AutoOptions = AUTO_DEFAULTS,
  ) {
    this.watchdog = initialWatchdog(now);
  }

  /** One report in: the sample for the overlay, and whether the network looks unstable. */
  step(
    report: StatsReportLike,
    now: number,
    inputs: PlaybackInputs,
  ): { sample: StatsSample; unstable: boolean } {
    const { source } = this;
    const next = readStats(report, this.counters, now);
    this.counters = next.counters;

    const watch = stepWatchdog(this.watchdog, {
      now,
      framesDecoded: next.framesDecoded,
      active: inputs.active && source.state.kind === 'live',
    });
    this.watchdog = watch.state;
    if (watch.retry) source.retry({ framesDecoded: next.framesDecoded });

    const rids = source.layers.map((l) => l.rid);
    const nominalFps = source.layers.find((l) => l.rid === source.layer)?.fps ?? null;
    const bad = judge(next, nominalFps, this.options) === 'bad';
    // "Unstable" is a sustained bad stretch, not one bad sample (a single freeze is not a problem).
    this.recent.push(bad);
    if (this.recent.length > this.options.unstableWindow) this.recent.shift();
    const sustained = this.recent.filter(Boolean).length >= this.options.unstableMin;
    if (inputs.quality !== 'auto' || source.state.kind !== 'live' || rids.length < 2) {
      this.auto = null;
      return { sample: next, unstable: sustained };
    }
    if (!this.auto) {
      this.start = startLayer(rids, inputs.cellular || inputs.economy);
      const first = this.start ?? rids[0] ?? 'f';
      this.auto = initialAuto(first, now);
      if (source.layer !== first) source.setLayer(first);
    }
    this.auto = stepAuto(this.auto, next, { layers: rids, nominalFps }, this.options);
    if (this.auto.layer !== source.layer) source.setLayer(this.auto.layer);
    const dropped =
      this.options.lowerLayerIsUnstable &&
      this.start !== null &&
      rids.indexOf(this.auto.layer) > rids.indexOf(this.start);
    return { sample: next, unstable: dropped || sustained };
  }
}
