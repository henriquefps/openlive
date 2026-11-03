// SPDX-License-Identifier: AGPL-3.0-only
import {
  BACKGROUND_PAUSE_MS,
  BackgroundPause,
  IDLE_ANSWER_MS,
  IDLE_MS,
  IdleCheck,
  AUTO_DEFAULTS,
  type IdleState,
  type MetricsSink,
  MetricsReporter,
  type Layer,
  PlaybackPolicy,
  type PlayerSource,
  type Quality,
  type RoomState,
  type Rid,
  type ScreenKind,
  screenFor,
  type SourceState,
  type StatsSample,
  type WatchAccess,
} from '@openlive/client';
import type { StreamInfo, VideoCodec } from '@openlive/protocol';

// Watching one stream from the phone, without React or react-native-webrtc so the tests can drive
// it: the viewer slot over the room socket (take, renew and release are RoomConnection's, PROTOCOL
// 7.3), the media source that pulls the stream once the slot is granted, the once-a-second
// playback loop (stats → stall watchdog → Automatic quality, @openlive/client's PlaybackPolicy) and
// the app-in-background rule (the web's background-tab rule, brake 5): a few seconds in the
// background the media stops while the slot is kept; after a minute the slot is given back too, and
// coming back asks for it again (a full stream shows its queue). It also carries the web's other two
// viewer rules: the idle brake (brake 6, "Still watching?" after IDLE_MS, the slot released when
// nobody answers) and the playback metrics, both @openlive/client's classes.

/** The part of RoomConnection the controller uses. */
export interface WatchRoom {
  getState(): RoomState;
  subscribe(listener: () => void): () => void;
  watch(streamId: string): void;
  unwatch(streamId: string): void;
  joinQueue(streamId: string): void;
  leaveQueue(streamId: string): void;
  acceptOffer(streamId: string): void;
}

/** What the controller needs from the RtcSource (the real one, or a fake in the tests). */
export interface WatchSource extends PlayerSource {
  start(): void;
  stop(): void;
  suspend(): void;
  resume(): void;
  update(stream: StreamInfo): void;
}

export interface WatchOptions<S extends WatchSource> {
  room: WatchRoom;
  streamId: string;
  /** Builds the source for a granted slot; the controller starts and stops it. */
  createSource: (stream: StreamInfo, slotId: string) => S;
  /** Whether the source's video track is muted (the sender stopped). */
  isTrackMuted?: (source: S) => boolean;
  /**
   * A cellular connection starts Automatic on the middle layer, like economy mode (a stream with
   * a quality cap); a layer the viewer picks is never overridden.
   */
  cellular?: () => boolean;
  /** Overrides the stream's own `qualityCap` (economy mode); tests use it. */
  economy?: boolean;
  /** Brake 6 ("Still watching?"); on unless the server turned it off. */
  idleCheck?: boolean;
  idleMs?: number;
  idleAnswerMs?: number;
  /** The viewer did not answer "Still watching?": the controller is closed, the view should leave. */
  onIdleStop?: () => void;
  /** Where the playback metrics go; none turns them off. */
  metrics?: { roomId: string; send: MetricsSink; windowMs?: number };
  /** The clock, in ms. */
  now?: () => number;
  /** The app goes unwatchable for this long: the media stops, the slot stays. */
  suspendAfterMs?: number;
  /** ... and for this long: the slot is released as well. */
  releaseAfterMs?: number;
  intervalMs?: number;
}

/**
 * Automatic on the phone: Android's MediaCodec reports a decode time that includes its output
 * delay (10–20 frames, ~250 ms at 60 fps) even when decoding keeps up, so the decode-time check
 * would step down and call the network unstable on a healthy stream.
 */
export const PHONE_AUTO = {
  ...AUTO_DEFAULTS,
  decodeBudget: null,
  // Measured on a Galaxy S24 Ultra: a freeze every 1–2 s at a steady 60 fps, loss 0 (not visible).
  freezesNeedLowFps: true,
  // "Unstable network" shows for a sustained problem (2 bad samples of the last 4), and not just
  // because Automatic is on a lower layer than it started on.
  unstableWindow: 4,
  unstableMin: 2,
  lowerLayerIsUnstable: false,
};

const DEBUG = process.env['EXPO_PUBLIC_OPENLIVE_DEBUG'] === '1';

/** Temporary diagnostics (EXPO_PUBLIC_OPENLIVE_DEBUG=1): one log line per stats sample. */
function debugStats(
  report: { forEach(cb: (entry: Record<string, unknown>) => void): void },
  layer: string | null,
  state: string,
  next: { sample: StatsSample; unstable: boolean },
): void {
  const inbound: Record<string, unknown>[] = [];
  report.forEach((e) => {
    if (e['type'] === 'inbound-rtp' && e['kind'] === 'video') {
      const keep: Record<string, unknown> = {};
      for (const k of [
        'ssrc',
        'frameWidth',
        'frameHeight',
        'framesReceived',
        'framesDecoded',
        'framesDropped',
        'keyFramesDecoded',
        'packetsReceived',
        'packetsLost',
        'bytesReceived',
        'pliCount',
        'firCount',
        'nackCount',
        'freezeCount',
        'totalDecodeTime',
        'jitterBufferDelay',
        'jitterBufferEmittedCount',
        'decoderImplementation',
        'lastPacketReceivedTimestamp',
      ])
        keep[k] = e[k];
      inbound.push(keep);
    }
  });
  const { sample } = next;
  console.log(
    'OLDBG ' +
      JSON.stringify({
        layer,
        state,
        unstable: next.unstable,
        codec: sample.codec,
        w: sample.width,
        jbMs: sample.jitterBufferMs,
        fps: sample.fps,
        decodeMs: sample.decodeMs,
        loss: sample.loss,
        dropped: sample.newFramesDropped,
        inbound,
      }),
  );
}

/** Brake 5's wait on the phone: shorter than the web's minute, the screen is simply off. */
export const SUSPEND_AFTER_MS = 10_000;
/** Then the slot goes back, the same minute the web waits before it stops the media. */
export const RELEASE_AFTER_MS = BACKGROUND_PAUSE_MS;

/** Taps and drags restart the idle count; one restart per this long is enough. */
export const ACTIVITY_THROTTLE_MS = 5_000;

export type Presence = 'foreground' | 'suspended' | 'released';

export interface WatchSnapshot<S extends WatchSource> {
  screen: ScreenKind;
  /** The stream as the room lists it; null once it left. */
  stream: StreamInfo | null;
  /** The streamer's display name, when the room lists them. */
  ownerName: string | null;
  access: WatchAccess | null;
  /** used/limit/queueLength of the stream's viewer slots, from the room's `viewers`. */
  viewers: { used: number; limit: number; queueLength: number } | null;
  source: S | null;
  sourceState: SourceState | null;
  layers: readonly Layer[];
  /** The layer being received, null before the first pull. */
  layer: Rid | null;
  quality: Quality;
  codec: VideoCodec | null;
  /** The last once-a-second sample (null before the first). */
  sample: StatsSample | null;
  unstable: boolean;
  /** A frame was decoded since the source last went live. */
  firstFrame: boolean;
  /** ms from the start to the first frame, once. */
  ttffMs: number | null;
  presence: Presence;
  /** Brake 6: asking "Still watching?" (with the deadline) or not. */
  idle: IdleState;
  /** The room's own end (kicked, closed, expired...) lives in `screen`. */
  closed: boolean;
}

export class WatchController<S extends WatchSource> {
  private snapshot: WatchSnapshot<S>;
  private readonly listeners = new Set<() => void>();
  private readonly room: WatchRoom;
  private readonly streamId: string;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly suspendBrake: BackgroundPause;
  private readonly releaseBrake: BackgroundPause;
  private offRoom: (() => void) | null = null;
  private offSource: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private slotId: string | null = null;
  private policy: PlaybackPolicy | null = null;
  private busy = false;
  private startedAt = 0;
  private started = false;
  private trackMuted = false;
  private idleCheck: IdleCheck | null = null;
  private idleEnabled: boolean;
  private lastActivity = Number.NEGATIVE_INFINITY;
  private reporter: MetricsReporter | null = null;
  private lastSourceKind: string | null = null;

  constructor(private readonly options: WatchOptions<S>) {
    this.room = options.room;
    this.streamId = options.streamId;
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = options.intervalMs ?? 1000;
    this.idleEnabled = options.idleCheck ?? true;
    this.suspendBrake = new BackgroundPause(
      {
        suspend: () => this.onSuspend(),
        resume: () => this.onResume(),
      },
      options.suspendAfterMs ?? SUSPEND_AFTER_MS,
    );
    this.releaseBrake = new BackgroundPause(
      {
        suspend: () => this.onRelease(),
        resume: () => this.onReturn(),
      },
      options.releaseAfterMs ?? RELEASE_AFTER_MS,
    );
    this.snapshot = this.derive({
      source: null,
      quality: 'auto',
      sample: null,
      unstable: false,
      firstFrame: false,
      ttffMs: null,
      presence: 'foreground',
      idle: { kind: 'watching' },
      closed: false,
    });
  }

  getSnapshot = (): WatchSnapshot<S> => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Asks for the slot and starts following the room. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = this.now();
    if (this.snapshot.closed) this.snapshot = { ...this.snapshot, closed: false };
    this.offRoom = this.room.subscribe(() => this.onRoom());
    this.room.watch(this.streamId);
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.startIdle();
    this.onRoom();
  }

  /**
   * Stops watching: the source is stopped and the slot released (or the queue left). `start()`
   * may follow (React's strict mode runs an effect, its cleanup and the effect again).
   */
  close(): void {
    if (this.snapshot.closed) return;
    this.dispose();
    if (this.started) this.room.unwatch(this.streamId);
    this.started = false;
    this.update({
      closed: true,
      source: null,
      sample: null,
      firstFrame: false,
      idle: { kind: 'watching' },
    });
  }

  /** The viewer touched the player: brake 6 counts from here (it does not answer the question). */
  activity(): void {
    if (!this.idleCheck) return;
    const at = this.now();
    if (at - this.lastActivity < ACTIVITY_THROTTLE_MS) return;
    this.lastActivity = at;
    this.idleCheck.activity();
  }

  /** "Keep watching". */
  confirmWatching(): void {
    this.idleCheck?.confirm();
  }

  /** The server's setting for brake 6, once it is known. */
  setIdleCheck(enabled: boolean): void {
    if (enabled === this.idleEnabled) return;
    this.idleEnabled = enabled;
    if (!enabled) this.stopIdle();
    else if (this.started && this.snapshot.presence !== 'released') this.startIdle();
  }

  setQuality(quality: Quality): void {
    this.update({ quality });
    const { source } = this.snapshot;
    if (source && quality !== 'auto' && source.state.kind === 'live') source.setLayer(quality);
  }

  /** The app came to the foreground (true) or left it (false): brake 5. */
  setForeground(foreground: boolean): void {
    if (this.snapshot.closed) return;
    this.suspendBrake.update(foreground);
    this.releaseBrake.update(foreground);
  }

  joinQueue(): void {
    this.room.joinQueue(this.streamId);
  }

  leaveQueue(): void {
    this.room.leaveQueue(this.streamId);
  }

  acceptOffer(): void {
    this.room.acceptOffer(this.streamId);
  }

  /** Pulls again now (the retry button after a failure). */
  retry(): void {
    this.snapshot.source?.retry();
  }

  /** One pass of the playback loop; public so tests and a foreground return can run it now. */
  async tick(): Promise<void> {
    const { source } = this.snapshot;
    if (!source || !this.policy || this.busy || this.snapshot.presence !== 'foreground') return;
    this.busy = true;
    try {
      const report = await source.getStats();
      if (this.snapshot.source !== source || !this.policy) return;
      const { quality } = this.snapshot;
      this.trackMuted = this.options.isTrackMuted?.(source) ?? false;
      const next = this.policy.step(report, this.now(), {
        quality,
        active: !this.snapshot.stream?.paused && !this.trackMuted,
        economy: this.options.economy ?? this.snapshot.stream?.qualityCap !== undefined,
        cellular: this.options.cellular?.() ?? false,
      });
      if (DEBUG) debugStats(report, source.layer, source.state.kind, next);
      let firstFrame = this.snapshot.firstFrame;
      let ttffMs = this.snapshot.ttffMs;
      if (!firstFrame && source.state.kind === 'live' && next.sample.framesDecoded > 0) {
        firstFrame = true;
        ttffMs ??= Math.round(this.now() - this.startedAt);
        this.reporter?.firstFrame(ttffMs);
      }
      if (this.reporter) {
        this.reporter.layer = source.layer;
        this.reporter.add(next.sample, !this.snapshot.stream?.paused && !this.trackMuted);
      }
      // A fixed layer: ask for it whenever the source is (back) live.
      if (quality !== 'auto' && source.state.kind === 'live' && source.layer !== quality) {
        source.setLayer(quality);
      }
      this.update({ sample: next.sample, unstable: next.unstable, firstFrame, ttffMs });
    } catch {
      // A failed stats read: the next pass tries again.
    } finally {
      this.busy = false;
    }
  }

  private dispose(): void {
    this.offRoom?.();
    this.offRoom = null;
    this.suspendBrake.dispose();
    this.releaseBrake.dispose();
    this.stopIdle();
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.stopSource();
  }

  private stopSource(): void {
    this.offSource?.();
    this.offSource = null;
    const { source } = this.snapshot;
    this.slotId = null;
    this.policy = null;
    this.trackMuted = false;
    // The last, shorter window goes out with the source (like the web's pagehide flush).
    this.reporter?.end();
    this.reporter = null;
    this.lastSourceKind = null;
    source?.stop();
  }

  private onSuspend(): void {
    this.update({ presence: 'suspended' });
    this.snapshot.source?.suspend();
  }

  private onResume(): void {
    if (this.snapshot.presence === 'released') return;
    this.update({ presence: 'foreground' });
    this.snapshot.source?.resume();
  }

  private onRelease(): void {
    this.stopSource();
    this.stopIdle();
    this.room.unwatch(this.streamId);
    this.update({ presence: 'released', source: null, sample: null, firstFrame: false });
  }

  private onReturn(): void {
    // The brake that suspended resumes after this one: a released view comes back with a new slot.
    this.update({ presence: 'foreground' });
    this.room.watch(this.streamId);
    this.startIdle();
    this.onRoom();
  }

  private onRoom(): void {
    if (this.snapshot.closed) return;
    const state = this.room.getState();
    const stream = state.streams.find((s) => s.streamId === this.streamId) ?? null;
    const access = state.access[this.streamId] ?? null;
    const granted = access?.kind === 'granted' ? access : null;
    const wanted = granted && stream && this.snapshot.presence !== 'released';
    if (wanted) {
      if (this.slotId !== granted.slotId || !this.snapshot.source) {
        this.stopSource();
        const source = this.options.createSource(stream, granted.slotId);
        this.slotId = granted.slotId;
        this.policy = new PlaybackPolicy(source, this.now(), PHONE_AUTO);
        this.offSource = source.subscribe(() => this.onSource());
        this.startReporter(stream);
        this.snapshot = { ...this.snapshot, source, firstFrame: false };
        source.start();
      } else {
        this.snapshot.source.update(stream);
      }
    } else if (this.snapshot.source) {
      this.stopSource();
      this.snapshot = { ...this.snapshot, source: null, sample: null, firstFrame: false };
    }
    this.update({});
  }

  private startReporter(stream: StreamInfo): void {
    const { metrics } = this.options;
    if (!metrics) return;
    this.reporter = new MetricsReporter({
      roomId: metrics.roomId,
      streamId: stream.streamId,
      start: 'click',
      send: metrics.send,
      now: this.now,
      ...(metrics.windowMs !== undefined ? { windowMs: metrics.windowMs } : {}),
    });
    this.reporter.begin();
  }

  private startIdle(): void {
    this.stopIdle();
    if (!this.idleEnabled) return;
    this.idleCheck = new IdleCheck(
      {
        onChange: (idle) => this.update({ idle }),
        onTimeout: () => {
          this.close();
          this.options.onIdleStop?.();
        },
      },
      this.options.idleMs ?? IDLE_MS,
      this.options.idleAnswerMs ?? IDLE_ANSWER_MS,
      this.now,
    );
    this.idleCheck.start();
  }

  private stopIdle(): void {
    this.idleCheck?.dispose();
    this.idleCheck = null;
    if (this.snapshot.idle.kind !== 'watching') this.update({ idle: { kind: 'watching' } });
  }

  private onSource(): void {
    const { source } = this.snapshot;
    // The web counts each trip into "reconnecting" in the window.
    const kind = source?.state.kind ?? null;
    if (kind === 'reconnecting' && this.lastSourceKind !== 'reconnecting')
      this.reporter?.reconnect();
    this.lastSourceKind = kind;
    // A new RTP stream (after a retry) starts its frame count over.
    if (source && source.state.kind !== 'live' && this.snapshot.firstFrame) {
      this.snapshot = { ...this.snapshot, firstFrame: false };
    }
    // A fixed layer chosen before the source was live applies as soon as it is.
    const { quality } = this.snapshot;
    if (source && quality !== 'auto' && source.state.kind === 'live' && source.layer !== quality) {
      source.setLayer(quality);
    }
    this.update({});
  }

  private derive(
    base: Pick<
      WatchSnapshot<S>,
      | 'source'
      | 'quality'
      | 'sample'
      | 'unstable'
      | 'firstFrame'
      | 'ttffMs'
      | 'presence'
      | 'idle'
      | 'closed'
    >,
  ): WatchSnapshot<S> {
    const state = this.room.getState();
    const stream = state.streams.find((s) => s.streamId === this.streamId) ?? null;
    const access = state.access[this.streamId] ?? null;
    const { source } = base;
    const screen = screenFor({
      room: { status: state.status, ended: state.ended },
      stream,
      endedReason: state.endedStreams[this.streamId] ?? null,
      access,
      source: source?.state ?? null,
      trackMuted: this.trackMuted,
      firstFrame: base.firstFrame,
      unstable: base.unstable,
    });
    const viewers = state.viewers[this.streamId];
    return {
      ...base,
      screen,
      stream,
      ownerName: stream
        ? (state.members.find((m) => m.userId === stream.userId)?.displayName ?? null)
        : null,
      access,
      viewers: viewers
        ? { used: viewers.used, limit: viewers.limit, queueLength: viewers.queueLength }
        : null,
      sourceState: source?.state ?? null,
      layers: source?.layers ?? [],
      layer: source?.layer ?? null,
      codec: source?.codec ?? null,
    };
  }

  private update(patch: Partial<WatchSnapshot<S>>): void {
    const { source } = { ...this.snapshot, ...patch };
    this.snapshot = this.derive({
      source,
      quality: patch.quality ?? this.snapshot.quality,
      sample: 'sample' in patch ? (patch.sample ?? null) : this.snapshot.sample,
      unstable: patch.unstable ?? this.snapshot.unstable,
      firstFrame: patch.firstFrame ?? this.snapshot.firstFrame,
      ttffMs: 'ttffMs' in patch ? (patch.ttffMs ?? null) : this.snapshot.ttffMs,
      presence: patch.presence ?? this.snapshot.presence,
      idle: patch.idle ?? this.snapshot.idle,
      closed: patch.closed ?? this.snapshot.closed,
    });
    for (const listener of [...this.listeners]) listener();
  }
}
