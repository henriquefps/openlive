// SPDX-License-Identifier: AGPL-3.0-only
import type { Preset, StreamInfo } from '@openlive/protocol';
import { LOW_LAYER, MIDDLE_LAYER, QUALITY_PRESETS } from '@openlive/usage';
import {
  type Layer,
  type PlayerSource,
  type Rid,
  RIDS,
  type SourceState,
  type StatsReportLike,
} from '../player/source.ts';
import type { VideoCodec } from '@openlive/protocol';
import { isWaitError } from '../api/client.ts';
import type { Stall } from '../player/source.ts';
import { errorCodeOf, type RtcSession, SessionClosed, SessionReset } from './session.ts';

// One watched stream on the room's SFU session: the PlayerSource the player talks to. It pulls
// with the slot the room socket granted, keeps one MediaStream for the player whatever happens
// underneath (a retry or a new session swaps its tracks), switches layers with PUT .../layer and
// pulls again when the transport needs it: the watchdog's retry, a new SFU session, or a stream
// that resumes after a pause (the SFU collects a pulled track that gets no packets).
// It asks for AV1 when the browser decodes it (rtc/codec.ts): the Worker answers
// with the stream's AV1 track for a pull on the top layer, H.264 otherwise. Leaving the top layer
// of an AV1 pull is a new pull (H.264) and the source stays on H.264 from then on, so Automatic
// never goes back and forth between the two tracks; a stalled AV1 pull falls back to H.264 too.

/**
 * The layers of a preset (@openlive/usage, as the helper sends them): the top one per preset (up to
 * 120 fps), h at 720p60 (never faster than the top), q at 480p30.
 */
export function presetLayers(preset: Preset): Layer[] {
  const top = QUALITY_PRESETS[preset];
  return [
    { rid: 'f', height: top.height, fps: top.fps },
    { rid: 'h', height: MIDDLE_LAYER.height, fps: Math.min(MIDDLE_LAYER.fps, top.fps) },
    { rid: 'q', height: LOW_LAYER.height, fps: LOW_LAYER.fps },
  ];
}

/**
 * The stream's layers: what the helper encodes when it says so (protocol 1.19; a native stream of
 * a 3440x1440 monitor is 3440x1440 at its real bitrate, not 2160p at 25 Mbps), the preset's
 * nominal ones from an older helper.
 */
export function streamLayers(stream: Pick<StreamInfo, 'preset' | 'layers'>): Layer[] {
  const real = (stream.layers ?? []).flatMap((l) => {
    const rid = asRid(l.rid);
    return rid ? [{ rid, width: l.width, height: l.height, fps: l.fps, kbps: l.kbps }] : [];
  });
  return real.length > 0 ? real : presetLayers(stream.preset);
}

const asRid = (rid: string | null): Rid | null =>
  rid !== null && (RIDS as readonly string[]).includes(rid) ? (rid as Rid) : null;

/** Waits between failed pulls; one more failure than this list is long and the source fails. */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

/** The platform's MediaStream, as far as the source needs it. */
export interface StreamLike<T extends object> {
  getTracks(): T[];
  addTrack(track: T): void;
  removeTrack(track: T): void;
}

export interface RtcSourceOptions<S extends StreamLike<T>, T extends object> {
  stream: StreamInfo;
  slotId: string;
  retryDelaysMs?: readonly number[];
  /** A new, empty MediaStream of the platform. */
  createStream: () => S;
  /** Told after the source swapped the tracks (a browser follows it through `addtrack`). */
  onTracksChanged?: (stream: S) => void;
  /** The codec to ask for (rtc/codec.ts's CodecPreference). */
  preferredCodec: () => VideoCodec;
  /** The AV1 pull stalled: when `decoderFailed`, no frame was ever decoded (CodecPreference). */
  noteAv1Failure?: () => void;
}

export class RtcSource<
  T extends object = object,
  S extends StreamLike<T> = StreamLike<T>,
> implements PlayerSource {
  state: SourceState = { kind: 'connecting' };
  layers: readonly Layer[] = [];
  layer: Rid | null = null;
  codec: VideoCodec | null = null;
  readonly stream: S;

  private readonly listeners = new Set<() => void>();
  private readonly streamId: string;
  private readonly slotId: string;
  private readonly retryDelaysMs: readonly number[];
  private info: Pick<StreamInfo, 'preset' | 'layers'>;
  private paused: boolean;
  /** Bumped by every pull and by stop(): answers to an older pull are dropped. */
  private token = 0;
  private failures = 0;
  private pulled = false;
  private stopped = false;
  /** Brake 5: the media is stopped while the slot is kept (player/brakes.ts). */
  private suspended = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private wantedLayer: Rid | null = null;
  private switching = false;
  /** A pull is on its way: a layer wanted meanwhile is applied when it lands. */
  private pulling = false;
  private offReset: (() => void) | null = null;
  /** This source pulls H.264: its AV1 pull stalled, or it left the AV1 layer. */
  private h264Only = false;
  private readonly codecFor: () => VideoCodec;

  constructor(
    private readonly session: RtcSession<T>,
    private readonly options: RtcSourceOptions<S, T>,
  ) {
    this.streamId = options.stream.streamId;
    this.info = options.stream;
    this.paused = options.stream.paused;
    this.slotId = options.slotId;
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.stream = options.createStream();
    this.codecFor = options.preferredCodec;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    this.offReset = this.session.onReset(() => {
      if (!this.suspended) void this.pull();
    });
    void this.pull();
  }

  /** Stops watching: closes the pulled tracks (the slot is released on the room socket). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.token += 1;
    this.clearRetry();
    this.offReset?.();
    void this.session.unpull(this.streamId, this);
  }

  retry(stall?: Stall): void {
    if (stall && this.codec === 'av1') {
      // A stalled AV1 pull: H.264 for this stream from now on; and when not a single frame was
      // decoded the decoder is what failed, so the whole tab asks for H.264.
      this.h264Only = true;
      if (stall.framesDecoded === 0) this.options.noteAv1Failure?.();
    }
    if (!this.stopped && !this.suspended) void this.pull();
  }

  /**
   * Stops receiving (the pulled tracks are closed, so the SFU sends nothing) but keeps the slot
   * and the session: resume() pulls again on the connected session, one round trip.
   */
  suspend(): void {
    if (this.stopped || this.suspended) return;
    this.suspended = true;
    this.token += 1;
    this.clearRetry();
    void this.session.unpull(this.streamId, this);
  }

  resume(): void {
    if (this.stopped || !this.suspended) return;
    this.suspended = false;
    void this.pull();
  }

  setLayer(rid: Rid): void {
    if (!this.layers.some((l) => l.rid === rid)) return;
    this.wantedLayer = rid;
    void this.switchLayer();
  }

  /** The stats of this source's own receivers, not the whole session's. */
  getStats(): Promise<StatsReportLike> {
    return this.session.getStats(this.stream.getTracks());
  }

  /** The room's latest StreamInfo for this stream (stream.updated). */
  update(stream: StreamInfo): void {
    const resumed = this.paused && !stream.paused;
    this.paused = stream.paused;
    const before = streamLayers(this.info);
    this.info = stream;
    if (this.layers.length > 0 && JSON.stringify(streamLayers(stream)) !== JSON.stringify(before)) {
      this.layers = streamLayers(stream);
      this.emit();
    }
    // While paused the helper sent nothing, and the SFU may have collected the pulled track.
    if (resumed && this.pulled && !this.suspended) void this.pull();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private setState(state: SourceState): void {
    this.state = state;
    this.emit();
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * `quiet`: a layer switch that takes a new pull (off the AV1 track). The source stays live, so
   * the player shows no reconnecting screen for a switch the viewer (or Automatic) asked for and
   * Automatic keeps its state; a failure is handled as any other.
   */
  private async pull(quiet = false): Promise<void> {
    if (this.stopped) return;
    this.clearRetry();
    const token = ++this.token;
    if (!quiet || this.state.kind !== 'live') {
      this.setState(
        this.pulled || this.failures > 0
          ? { kind: 'reconnecting', attempt: this.failures + 1 }
          : { kind: 'connecting' },
      );
    }
    this.pulling = true;
    try {
      const pulled = await this.session.pull(
        {
          streamId: this.streamId,
          slotId: this.slotId,
          ...(this.layer ? { rid: this.layer } : {}),
          codec: this.h264Only ? 'h264' : this.codecFor(),
        },
        this,
      );
      if (token !== this.token) return;
      this.pulling = false;
      this.replaceTracks(pulled.tracks);
      this.codec = pulled.codec;
      const rid = asRid(pulled.rid);
      this.layers = rid ? streamLayers(this.info) : [];
      this.layer = rid;
      this.failures = 0;
      this.pulled = true;
      this.setState({ kind: 'live' });
      if (this.wantedLayer && this.wantedLayer !== rid) void this.switchLayer();
    } catch (error) {
      if (token !== this.token) return;
      this.pulling = false;
      this.onPullError(error);
    }
  }

  private onPullError(error: unknown): void {
    // A new session is on its way and onReset pulls again; or the room page is gone.
    if (error instanceof SessionReset || error instanceof SessionClosed) return;
    // 429 or do_quota_exceeded: a retry in seconds only repeats it. The session waits it out and
    // its onReset pulls again once it opens; until then this source asks for nothing.
    if (isWaitError(error)) {
      this.setState({ kind: 'reconnecting', attempt: this.failures + 1 });
      return;
    }
    switch (errorCodeOf(error)) {
      case 'forbidden':
      case 'unauthenticated':
        this.setState({ kind: 'failed', reason: 'no_permission' });
        return;
      case 'slot_not_found':
      case 'stream_not_found':
        // The room socket follows up: a new slot (a new source) or stream.ended.
        return;
      default:
        break;
    }
    this.failures += 1;
    const delay = this.retryDelaysMs[this.failures - 1];
    if (delay === undefined) {
      this.setState({ kind: 'failed', reason: 'network' });
      return;
    }
    this.setState({ kind: 'reconnecting', attempt: this.failures });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.pull();
    }, delay);
  }

  /** The newest wanted layer wins; one PUT .../layer at a time. */
  private async switchLayer(): Promise<void> {
    // The pull on its way switches to the wanted layer when it lands.
    if (this.switching || this.pulling) return;
    this.switching = true;
    try {
      while (
        !this.stopped &&
        this.state.kind === 'live' &&
        this.wantedLayer !== null &&
        this.wantedLayer !== this.layer
      ) {
        const rid = this.wantedLayer;
        const token = this.token;
        if (this.codec === 'av1') {
          // The AV1 track is the top layer alone: another layer is a pull on the
          // H.264 track, which the Worker picks for any layer but the top one. The source stays on
          // H.264 from then on: going back up is a PUT .../layer, and a later pull (a retry, a
          // resume) does not bring the AV1 track back. Automatic leaves the top layer when the
          // viewer cannot keep up with it, and an AV1 pull each time it climbed back made it pull
          // again on every step.
          this.h264Only = true;
          this.layer = rid;
          void this.pull(true);
          return;
        }
        try {
          await this.session.setLayer(this.streamId, rid);
        } catch (error) {
          if (token !== this.token) return;
          const code = errorCodeOf(error);
          if (code === 'invalid_message') {
            // The helper does not publish this layer (test-stream --layers): stop offering it.
            this.layers = this.layers.filter((l) => l.rid !== rid);
            this.wantedLayer = null;
            this.emit();
          } else if (code === 'stream_not_found') {
            // The subscription is gone on the Worker's side: pull again on the wanted layer.
            this.layer = rid;
            void this.pull();
          }
          return;
        }
        if (token !== this.token) return;
        this.layer = rid;
        this.emit();
      }
    } finally {
      this.switching = false;
    }
  }

  private replaceTracks(tracks: readonly T[]): void {
    const current = this.stream.getTracks();
    for (const track of current) if (!tracks.includes(track)) this.stream.removeTrack(track);
    for (const track of tracks) if (!current.includes(track)) this.stream.addTrack(track);
    // addTrack() fires no event in a browser; the player follows the video track through
    // `addtrack`, which the web's wrapper dispatches.
    this.options.onTracksChanged?.(this.stream);
  }
}
