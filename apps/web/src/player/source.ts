// SPDX-License-Identifier: AGPL-3.0-only
import type { VideoCodec } from '@openlive/protocol';

// The seam between the player UI and whatever delivers the media. The
// player only sees a MediaStream and this interface: the fake source (dev) implements it today, the
// rtc client (SFU session per room, pull with tracks/new, layer switch with tracks/update) later.

/** Simulcast encodings, highest first: full, half, quarter. */
export type Rid = 'f' | 'h' | 'q';
export const RIDS: readonly Rid[] = ['f', 'h', 'q'];

/** One simulcast layer as the viewer can pick it. */
export interface Layer {
  rid: Rid;
  /**
   * Height and frame rate, for the quality menu (720p60, 480p30...): what the helper encodes when
   * it says so (protocol 1.19, a 3440x1440 native stream is 1440p60), the preset's otherwise.
   */
  height: number;
  fps: number;
  /** Width and target bitrate, when the helper reports them (protocol 1.19). */
  width?: number;
  kbps?: number;
}

/**
 * What the transport is doing. `failed` carries a reason the player turns into a screen of its own;
 * a stall the watchdog sees is not a state here, it calls `retry()`.
 */
export type SourceState =
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'failed'; reason: SourceFailure };

export type SourceFailure = 'no_permission' | 'helper_outdated' | 'network';

/**
 * The stats the player reads: an `RTCStatsReport` or anything with the same `forEach`, so a fake
 * source can hand out synthetic numbers.
 */
export interface StatsReportLike {
  forEach(callback: (value: Record<string, unknown> & { type: string; id: string }) => void): void;
}

/** What the watchdog saw when it gave up on the frames. */
export interface Stall {
  /** Frames decoded on the current RTP stream: 0 means the decoder never produced one. */
  framesDecoded: number;
}

export interface PlayerSource {
  readonly state: SourceState;
  /** Layers on offer, highest first. Empty when the stream is not simulcast. */
  readonly layers: readonly Layer[];
  /** The layer being received now, or null before the first pull. */
  readonly layer: Rid | null;
  /** Switch layers without renegotiating (`tracks/update`, about 300 ms when measured). */
  setLayer(rid: Rid): void;
  getStats(): Promise<StatsReportLike>;
  /**
   * Pull again after a stall (the watchdog, which passes `stall`) or a failure (the retry button).
   * A stalled AV1 pull is pulled again in H.264.
   */
  retry(stall?: Stall): void;
  /** The codec of the video being received (null before the first pull, or unknown). */
  readonly codec?: VideoCodec | null;
  /** Called on every change to `state`, `layers` or `layer`. */
  subscribe(listener: () => void): () => void;
}
