// SPDX-License-Identifier: AGPL-3.0-only
import type { IceServersResponse, SessionDescription, VideoCodec } from '@openlive/protocol';
import { ApiError, isWaitError } from '../api/client.ts';
import type { StatsReportLike } from '../player/source.ts';
import type { RtcApi } from './api.ts';
import { joinMsidStreams, type MsidPair } from './lip-sync.ts';

// The viewer's one SFU session per room: opened when the room page opens, with an offer
// that carries only a data channel, so DTLS is connected before any click. A click then pulls the
// stream onto the connected session (POST .../subscribe), and the SFU's offer is answered through
// PUT .../renegotiate. Every pull and close goes through one queue, so two pulls never interleave
// their SDP. Closing a pull (or pulling the same stream again) stops its transceivers here as well:
// the Worker closes the SFU's tracks with force (no SDP), and the SFU keeps offering their
// m-sections, so a receiver left running gets no packets and asks for a keyframe every few seconds
// (the SFU relays each PLI to the helper as a forced IDR). When the session dies (ICE fails, or
// the Worker no longer knows it) a new one is created and every source pulling on the old one is
// told to pull again (`onReset`). Voice (src/voice) uses the same session: it publishes the
// microphone as a sendonly m-section offered by the browser (`publish`), and pulls the others'
// microphones a few tracks at a time (`pullTracks`), through the same queue. Cameras (since 1.12)
// publish one simulcast video the same way, and their pulls name the owner's microphone
// (`setMsidLinks`) so both play in one msid stream, in sync.

/** An SDP in the shape RTCSessionDescriptionInit has. */
export interface SdpInit {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string | undefined;
}

export type PeerConnectionState =
  'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

/** What the session passes to the peer constructor (RTCConfiguration, in a browser). */
export interface PeerConfiguration {
  iceServers: IceServersResponse['iceServers'];
  bundlePolicy: 'max-bundle';
}

/** One simulcast encoding, as RTCRtpEncodingParameters names it. */
export interface EncodingLike {
  rid?: string;
  active?: boolean;
}

/**
 * The subset of RTCPeerConnection the session uses, so tests can pass a fake and the mobile app
 * can pass react-native-webrtc's. `T` is the platform's MediaStreamTrack.
 */
export interface PeerLike<T extends object = object> {
  readonly connectionState: PeerConnectionState;
  readonly localDescription: { type: string; sdp: string } | null;
  onconnectionstatechange: ((event: never) => void) | null;
  createDataChannel(label: string): unknown;
  createOffer(): Promise<SdpInit>;
  createAnswer(): Promise<SdpInit>;
  setLocalDescription(description?: SdpInit): Promise<void>;
  setRemoteDescription(description: SdpInit): Promise<void>;
  getTransceivers(): readonly TransceiverLike<T>[];
  addTransceiver(
    track: T,
    init: { direction: 'sendonly'; sendEncodings?: EncodingLike[] },
  ): LocalTransceiverLike<T>;
  getStats(): Promise<StatsReportLike>;
  close(): void;
}

export interface TransceiverLike<T extends object = object> {
  readonly mid: string | null;
  readonly currentDirection: string | null;
  readonly receiver: {
    track: T;
    /** This receiver's stats alone (RTCRtpReceiver.getStats); absent in older fakes. */
    getStats?(): Promise<StatsReportLike>;
  };
  stop(): void;
}

/** A transceiver this side sends on (the microphone, the camera). */
export interface LocalTransceiverLike<T extends object = object> {
  readonly mid: string | null;
  readonly sender: {
    replaceTrack(track: T | null): Promise<void>;
    getParameters?(): { encodings: EncodingLike[] };
    setParameters?(parameters: { encodings: EncodingLike[] }): Promise<void>;
  };
  stop(): void;
}

/** A track published with `publish`, on the session that was live then. */
export interface Publication<T extends object = object> {
  readonly sessionId: string;
  readonly mid: string;
  /** Swaps the sent track (another microphone) or sends nothing (null), with no renegotiation. */
  replaceTrack(track: T | null): Promise<void>;
  /**
   * Turns simulcast layers on or off by rid, with no renegotiation (a camera on a bad network
   * sends its low layer only, or nothing).
   */
  setActiveLayers(active: (rid: string) => boolean): Promise<void>;
}

/** Two pulled tracks, by their pull keys, to play in one msid stream (a camera and its voice). */
export interface MsidLink {
  video: string;
  audio: string;
}

/** A pull of several tracks at once (voice): the SFU's answer, by caller-chosen key. */
export interface TracksPulled {
  requiresImmediateRenegotiation: boolean;
  sessionDescription?: SessionDescription | undefined;
  tracks: { key: string; mid: string }[];
}

export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'closed';

/** The session the call ran on is gone; sources pull again when `onReset` fires. */
export class SessionReset extends Error {
  constructor() {
    super('SFU session reset');
    this.name = 'SessionReset';
  }
}

/** The room page went away (`close()`); nothing to retry. */
export class SessionClosed extends Error {
  constructor() {
    super('SFU session closed');
    this.name = 'SessionClosed';
  }
}

export interface PullRequest {
  streamId: string;
  slotId: string;
  /** Start on this simulcast layer; the stream's highest when absent. */
  rid?: string;
  /** The video codec to ask for (since 1.14); the Worker may answer with H.264 anyway. */
  codec?: VideoCodec;
}

export interface Pulled<T extends object = object> {
  /** The layer the SFU sends; null when the stream is not simulcast. */
  rid: string | null;
  /** The pulled tracks (video, and audio when the stream has it). */
  tracks: T[];
  /** The pulled video's codec (h264 from servers before 1.14). */
  codec: VideoCodec;
}

export interface SessionOptions<T extends object = object> {
  api: RtcApi;
  /** Builds the peer connection: `new RTCPeerConnection` of the platform. */
  createPeer: (configuration: PeerConfiguration) => PeerLike<T>;
  /** `disconnected` this long counts as failed (ICE sometimes recovers on its own). */
  disconnectGraceMs?: number;
  now?: () => number;
}

interface Live<T extends object> {
  pc: PeerLike<T>;
  sessionId: string;
  /**
   * Each stream (or voice track) pulled on this session: who pulled it last, on which mids, and
   * how to close it at the SFU.
   */
  pulls: Map<
    string,
    { owner: object; mids: string[]; close: (sessionId: string) => Promise<void> }
  >;
  /** Tracks this side publishes, by mid. */
  published: Map<string, LocalTransceiverLike<T>>;
}

export const PRECONNECT_RETRY_BASE_MS = 1_000;
export const PRECONNECT_RETRY_MAX_MS = 30_000;
/**
 * After a wait error (429, 503 do_quota_exceeded: isWaitError, the same rule as the queries'),
 * the session asks nothing of the API for this long: the room socket tries again every 15
 * minutes after the same quota close (room/connection.ts QUOTA_RETRY_MS), a rate limit clears
 * sooner.
 */
export const QUOTA_WAIT_MS = 15 * 60_000;
export const RATE_LIMIT_WAIT_MS = 60_000;

const EMPTY_STATS: StatsReportLike = { forEach: () => undefined };

export function errorCodeOf(error: unknown): string | null {
  return error instanceof ApiError ? error.body.code : null;
}

function description(peer: PeerLike<object>): SessionDescription {
  const local = peer.localDescription;
  if (!local || (local.type !== 'offer' && local.type !== 'answer')) {
    throw new Error('no local description');
  }
  return { type: local.type, sdp: local.sdp };
}

export class RtcSession<T extends object = object> {
  status: SessionStatus = 'idle';
  /** POST .../ice → DTLS connected, for stats for nerds; null before the first connect. */
  connectMs: number | null = null;
  private live: Live<T> | null = null;
  private pending: Promise<Live<T>> | null = null;
  /** Bumped by `close()`: a connect started before it must not install its session. */
  private generation = 0;
  /** Bumped by `start()`: a `closeAfterUnpulls()` waiting in the queue yields to a restart. */
  private starts = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private connectStartedAt = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Failed pre-connects in a row, and the timer of the next try. */
  private failures = 0;
  /**
   * After a wait error: the error and until when (on `now()`) every connect fails with it at once,
   * without a request. Pulls that failed meanwhile pull again on `onReset` once a session opens.
   */
  private waiting: { error: unknown; until: number } | null = null;
  /** A wait error happened since the last open session. */
  private waited = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly resetListeners = new Set<() => void>();
  /** Pulled tracks that play together (`setMsidLinks`), applied to every offer from the SFU. */
  private links: readonly MsidLink[] = [];
  private readonly api: RtcApi;
  private readonly createPeer: (configuration: PeerConfiguration) => PeerLike<T>;
  private readonly disconnectGraceMs: number;
  private readonly now: () => number;

  constructor(options: SessionOptions<T>) {
    this.api = options.api;
    this.createPeer = options.createPeer;
    this.disconnectGraceMs = options.disconnectGraceMs ?? 5_000;
    this.now = options.now ?? (() => globalThis.performance.now());
  }

  /** The current session id, for tests and stats; null while there is none. */
  get sessionId(): string | null {
    return this.live?.sessionId ?? null;
  }

  getStatus = (): SessionStatus => this.status;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Called when the session was replaced: whoever pulled on it must pull again. */
  onReset(listener: () => void): () => void {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  }

  /** Pre-connect: open the session now, before anyone clicks a stream. */
  start(): void {
    this.starts += 1;
    const reopened = this.status === 'closed';
    if (reopened) this.setStatus('idle');
    this.clearRetryTimer();
    this.ensure().then(
      () => {
        this.failures = 0;
        if (this.waited) {
          // Sources stopped retrying during the wait: they pull on the new session now.
          this.waited = false;
          for (const listener of [...this.resetListeners]) listener();
        }
      },
      (error: unknown) => {
        if (!(error instanceof SessionClosed)) this.retryLater();
      },
    );
    // Back from the back/forward cache: sources still on screen pull on the new session.
    if (reopened) for (const listener of [...this.resetListeners]) listener();
  }

  /**
   * The page or the room view went away: close the connection and tell the Worker, with a beacon
   * that survives the unload, to close everything pulled on the session. `start()` opens a new
   * one (a page restored from the back/forward cache).
   */
  close(): void {
    this.generation += 1;
    this.pending = null;
    this.clearDisconnectTimer();
    this.clearRetryTimer();
    this.failures = 0;
    this.waiting = null;
    this.waited = false;
    const live = this.live;
    this.live = null;
    if (live) {
      live.pc.onconnectionstatechange = null;
      live.pc.close();
      this.api.leave(live.sessionId);
    }
    this.setStatus('closed');
  }

  /**
   * Like `close()`, but after the queued pulls and closes ran: every pull still open is closed at
   * the SFU first, and only then does the session leave. `close()` leaves at once, so an `unpull`
   * queued just before it would reach the Worker after `leave` (a 404). A `start()` in between
   * (React strict mode) cancels the close.
   */
  closeAfterUnpulls(): Promise<void> {
    const starts = this.starts;
    return this.serial(async () => {
      if (starts !== this.starts) return;
      const live = this.live;
      if (live) for (const key of [...live.pulls.keys()]) await this.release(live, key);
      if (starts === this.starts) this.close();
    });
  }

  /**
   * Pulls a stream onto the session and answers the SFU's offer. `owner` (the source) is who may
   * close the pull with `unpull`: a newer pull of the same stream takes it over.
   */
  pull(request: PullRequest, owner: object): Promise<Pulled<T>> {
    return this.serial(() =>
      this.withLive(async (live) => {
        const { streamId, slotId, rid, codec } = request;
        // Pulled before on this session (a retry, a resume, a new source for the same stream).
        if (live.pulls.has(streamId)) await this.release(live, streamId);
        const res = await this.api.subscribe({
          sessionId: live.sessionId,
          slotId,
          streamId,
          ...(rid ? { rid } : {}),
          ...(codec ? { codec } : {}),
        });
        if (live !== this.live) throw new SessionReset();
        live.pulls.set(streamId, {
          owner,
          mids: res.tracks.map((t) => t.mid),
          close: (sessionId) => this.api.unsubscribe(sessionId, streamId),
        });
        const { pc } = live;
        if (res.requiresImmediateRenegotiation && res.sessionDescription) {
          const video = res.tracks.find((t) => t.kind === 'video')?.mid;
          const audio = res.tracks.find((t) => t.kind === 'audio')?.mid;
          // Name the pair: older pulls may have left other m-sections on this session.
          const pairs = [...(video && audio ? [{ video, audio }] : []), ...this.linkedPairs(live)];
          await pc.setRemoteDescription({
            type: res.sessionDescription.type,
            sdp: joinMsidStreams(res.sessionDescription.sdp, pairs),
          });
          await pc.setLocalDescription(await pc.createAnswer());
          await this.api.renegotiate(live.sessionId, description(pc));
        }
        const transceivers = pc.getTransceivers();
        const tracks = res.tracks.flatMap((t) => {
          const track = transceivers.find((x) => x.mid === t.mid)?.receiver.track;
          return track ? [track] : [];
        });
        return { rid: res.rid ?? null, tracks, codec: res.codec ?? 'h264' };
      }),
    );
  }

  /**
   * Publishes a local track: a sendonly m-section in an offer from this side, which `send` hands
   * to the SFU (with the new mid) and whose answer it returns.
   */
  publish(
    track: T,
    send: (
      sessionId: string,
      offer: SessionDescription,
      mid: string,
    ) => Promise<SessionDescription>,
    sendEncodings?: EncodingLike[],
  ): Promise<Publication<T>> {
    return this.serial(() =>
      this.withLive(async (live) => {
        const { pc } = live;
        const transceiver = pc.addTransceiver(track, {
          direction: 'sendonly',
          ...(sendEncodings ? { sendEncodings } : {}),
        });
        try {
          await pc.setLocalDescription(await pc.createOffer());
          const mid = transceiver.mid;
          if (mid === null) throw new Error('no mid for the published track');
          const answer = await send(live.sessionId, description(pc), mid);
          if (live !== this.live) throw new SessionReset();
          await pc.setRemoteDescription(answer);
          live.published.set(mid, transceiver);
          return {
            sessionId: live.sessionId,
            mid,
            replaceTrack: (next) => transceiver.sender.replaceTrack(next),
            setActiveLayers: async (active) => {
              const { sender } = transceiver;
              if (!sender.getParameters || !sender.setParameters) return;
              const parameters = sender.getParameters();
              parameters.encodings = parameters.encodings.map((e) => ({
                ...e,
                active: e.rid === undefined ? active('') : active(e.rid),
              }));
              await sender.setParameters(parameters);
            },
          };
        } catch (error) {
          transceiver.stop();
          throw error;
        }
      }),
    );
  }

  /**
   * Stops sending a published track and closes it at the SFU (`close`). Nothing to do when the
   * session it was published on is gone: the Worker closed it with the session.
   */
  unpublish(
    publication: Publication<T>,
    close: (sessionId: string) => Promise<void>,
  ): Promise<void> {
    return this.serial(async () => {
      const live = this.live;
      if (!live || live.sessionId !== publication.sessionId) return;
      const transceiver = live.published.get(publication.mid);
      live.published.delete(publication.mid);
      transceiver?.stop();
      await close(live.sessionId).catch(() => undefined);
    });
  }

  /**
   * Pulls several tracks in one request (voice: up to four per call) and answers the SFU's
   * offer. Keys pulled before on this session are closed first. `close` closes one key's track at
   * the SFU when it is unpulled.
   */
  pullTracks(
    keys: readonly string[],
    fetch: (sessionId: string) => Promise<TracksPulled>,
    close: (sessionId: string, key: string) => Promise<void>,
    owner: object,
  ): Promise<Map<string, T>> {
    return this.serial(() =>
      this.withLive(async (live) => {
        for (const key of keys) if (live.pulls.has(key)) await this.release(live, key);
        const res = await fetch(live.sessionId);
        if (live !== this.live) throw new SessionReset();
        for (const t of res.tracks) {
          live.pulls.set(t.key, {
            owner,
            mids: [t.mid],
            close: (sessionId) => close(sessionId, t.key),
          });
        }
        const { pc } = live;
        if (res.requiresImmediateRenegotiation && res.sessionDescription) {
          const pairs = this.linkedPairs(live);
          await pc.setRemoteDescription({
            type: res.sessionDescription.type,
            sdp:
              pairs.length > 0
                ? joinMsidStreams(res.sessionDescription.sdp, pairs)
                : res.sessionDescription.sdp,
          });
          await pc.setLocalDescription(await pc.createAnswer());
          await this.api.renegotiate(live.sessionId, description(pc));
        }
        const transceivers = pc.getTransceivers();
        const tracks = new Map<string, T>();
        for (const t of res.tracks) {
          const track = transceivers.find((x) => x.mid === t.mid)?.receiver.track;
          if (track) tracks.set(t.key, track);
        }
        return tracks;
      }),
    );
  }

  /**
   * Which pulled tracks play together, by pull key (a camera and its owner's microphone).
   * Applied to every later offer of the SFU; a link whose keys are not both pulled waits.
   */
  setMsidLinks(links: readonly MsidLink[]): void {
    this.links = links;
  }

  /** Runs `fn` with the live session's id (a camera's layer switch), connecting if needed. */
  withSessionId<R>(fn: (sessionId: string) => Promise<R>): Promise<R> {
    return this.withLive((live) => fn(live.sessionId));
  }

  /** Switches a pulled stream's simulcast layer with tracks/update: no renegotiation. */
  setLayer(streamId: string, rid: string): Promise<void> {
    return this.withLive((live) => this.api.layer({ sessionId: live.sessionId, streamId, rid }));
  }

  /**
   * Closes a stream's pulled tracks (the slot is released on the room socket), unless another
   * owner pulled the stream since: that pull already closed this one's.
   */
  unpull(streamId: string, owner: object): Promise<void> {
    return this.serial(async () => {
      const live = this.live;
      const pull = live?.pulls.get(streamId);
      if (!live) return;
      if (pull?.owner === owner) await this.release(live, streamId);
      // Not pulled here (yet): close it at the SFU all the same, in case the pull got that far.
      else if (!pull) await this.api.unsubscribe(live.sessionId, streamId).catch(() => undefined);
    });
  }

  /** Closes pulled voice tracks, unless another owner pulled them since. */
  unpullTracks(keys: readonly string[], owner: object): Promise<void> {
    return this.serial(async () => {
      const live = this.live;
      if (!live) return;
      for (const key of keys) {
        if (live.pulls.get(key)?.owner === owner) await this.release(live, key);
      }
    });
  }

  /**
   * The session's stats, or with `tracks` only those of the receivers playing them: a stopped
   * receiver or another pull on this session must not stand in for the player's own (a stale
   * report with more frames hid the live one from the watchdog, which then pulled again every
   * 30 s and made the helper send an IDR to every viewer each time).
   */
  async getStats(tracks?: readonly T[]): Promise<StatsReportLike> {
    const live = this.live;
    if (!live) return EMPTY_STATS;
    if (!tracks) return live.pc.getStats();
    const receivers = live.pc
      .getTransceivers()
      .filter((t) => t.currentDirection !== 'stopped' && tracks.includes(t.receiver.track))
      .map((t) => t.receiver);
    if (receivers.length === 0 || receivers.some((r) => !r.getStats)) return live.pc.getStats();
    const reports = await Promise.all(receivers.map((r) => r.getStats?.() ?? EMPTY_STATS));
    const merged = new Map<string, Record<string, unknown> & { type: string; id: string }>();
    for (const report of reports) report.forEach((entry) => merged.set(entry.id, entry));
    return merged;
  }

  /** The msid links whose two keys are pulled on `live`, as mid pairs. */
  private linkedPairs(live: Live<T>): MsidPair[] {
    return this.links.flatMap((link) => {
      const video = live.pulls.get(link.video)?.mids[0];
      const audio = live.pulls.get(link.audio)?.mids[0];
      return video && audio ? [{ video, audio }] : [];
    });
  }

  /** Stops a pull's receivers on this side, then closes its pulled tracks at the SFU. */
  private async release(live: Live<T>, key: string): Promise<void> {
    const pull = live.pulls.get(key);
    const mids = pull?.mids ?? [];
    live.pulls.delete(key);
    for (const transceiver of live.pc.getTransceivers()) {
      if (
        transceiver.mid !== null &&
        mids.includes(transceiver.mid) &&
        transceiver.currentDirection !== 'stopped'
      )
        transceiver.stop();
    }
    await pull?.close(live.sessionId).catch(() => undefined);
  }

  private setStatus(status: SessionStatus): void {
    if (status === this.status) return;
    this.status = status;
    for (const listener of this.listeners) listener();
  }

  private serial<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async withLive<R>(fn: (live: Live<T>) => Promise<R>): Promise<R> {
    const live = await this.ensure();
    try {
      return await fn(live);
    } catch (error) {
      // The Worker forgot the session (more than 8 per user, or it expired): start over.
      if (errorCodeOf(error) === 'sfu_session_not_found') {
        this.reset(live);
        throw new SessionReset();
      }
      throw error;
    }
  }

  private ensure(): Promise<Live<T>> {
    if (this.live) return Promise.resolve(this.live);
    if (this.status === 'closed') return Promise.reject(new SessionClosed());
    if (this.waiting) {
      if (this.now() < this.waiting.until) return Promise.reject(this.waiting.error);
      this.waiting = null;
    }
    if (!this.pending) {
      const generation = this.generation;
      const pending = this.connect(generation).finally(() => {
        if (this.pending === pending) this.pending = null;
      });
      this.pending = pending;
    }
    return this.pending;
  }

  private async connect(generation: number): Promise<Live<T>> {
    this.connectStartedAt = this.now();
    this.setStatus('connecting');
    let pc: PeerLike<T> | null = null;
    try {
      const { iceServers } = await this.api.ice();
      if (generation !== this.generation) throw new SessionClosed();
      pc = this.createPeer({ iceServers, bundlePolicy: 'max-bundle' });
      // Only a data channel: enough for DTLS to connect with no media.
      pc.createDataChannel('openlive');
      await pc.setLocalDescription(await pc.createOffer());
      const res = await this.api.session(description(pc));
      if (generation !== this.generation) {
        this.api.leave(res.sessionId);
        throw new SessionClosed();
      }
      if (res.sessionDescription) await pc.setRemoteDescription(res.sessionDescription);
      const live: Live<T> = {
        pc,
        sessionId: res.sessionId,
        pulls: new Map(),
        published: new Map(),
      };
      pc.onconnectionstatechange = () => this.onConnectionState(live);
      this.live = live;
      this.onConnectionState(live);
      return live;
    } catch (error) {
      pc?.close();
      if (generation === this.generation) {
        if (isWaitError(error)) {
          const status = error instanceof ApiError ? error.status : 0;
          const wait = status === 429 ? RATE_LIMIT_WAIT_MS : QUOTA_WAIT_MS;
          this.waiting = { error, until: this.now() + wait };
          this.waited = true;
        }
        this.setStatus('idle');
      }
      throw error;
    }
  }

  private onConnectionState(live: Live<T>): void {
    if (live !== this.live) return;
    switch (live.pc.connectionState) {
      case 'connected':
        this.clearDisconnectTimer();
        this.connectMs ??= Math.round(this.now() - this.connectStartedAt);
        this.setStatus('connected');
        return;
      case 'disconnected':
        if (this.disconnectTimer !== null) return;
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          if (live.pc.connectionState === 'disconnected') this.reset(live);
        }, this.disconnectGraceMs);
        return;
      case 'failed':
        this.reset(live);
        return;
      default:
        return;
    }
  }

  /** Drops a dead session, opens a new one and tells the sources to pull again. */
  private reset(live: Live<T>): void {
    if (live !== this.live) return;
    this.clearDisconnectTimer();
    this.live = null;
    live.pc.onconnectionstatechange = null;
    live.pc.close();
    this.api.leave(live.sessionId);
    this.setStatus('idle');
    this.start();
    for (const listener of [...this.resetListeners]) listener();
  }

  /**
   * The pre-connect failed (the SFU or the Worker refused): try again, backing off to 30 s; after
   * a wait error, once the wait is over.
   */
  private retryLater(): void {
    if (this.status === 'closed' || this.live || this.retryTimer !== null) return;
    this.failures += 1;
    const delay = this.waiting
      ? Math.max(0, this.waiting.until - this.now())
      : Math.min(PRECONNECT_RETRY_MAX_MS, PRECONNECT_RETRY_BASE_MS * 2 ** (this.failures - 1));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer !== null) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }
}
