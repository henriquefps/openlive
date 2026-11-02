// SPDX-License-Identifier: AGPL-3.0-only
import type { RoomSettings } from '@openlive/protocol';
import { capabilitiesOf } from '../lib/capabilities.ts';
import type { EndReason, RoomState } from '../room/connection.ts';
import type { StatsReportLike } from '../player/source.ts';
import type { SessionStatus } from '../rtc/session.ts';
import type { CameraClientState, NetworkQuality } from './camera.ts';
import type { VoiceClientState, VoiceSignal } from './client.ts';
import type { VoiceLeftReason } from './contract.ts';
import type { NetworkMeter } from './network.ts';

// The app's voice session (voice survives navigation, as on
// Discord). A room's connection (room socket, SFU session, voice and camera clients) lives in
// a RoomSession kept by VoiceSessions, not by the room page: the page holds it while it shows the
// room, and being in voice holds it too, so leaving the page keeps the voice. Opening the same
// room again reuses it (no second socket). One room is in voice at a time: joining another asks to
// switch first. Leaving voice in a room nobody shows closes the whole connection.
//
// Every part is an interface, so the state machine runs against fakes in tests.

/** The room socket, as the session drives it (room/connection.ts). */
export interface SessionConnection {
  getState(): RoomState;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  reconnect(): void;
}

/** The room's SFU session (rtc/session.ts). */
export interface SessionRtc {
  getStatus(): SessionStatus;
  subscribe(listener: () => void): () => void;
  start(): void;
  close(): void;
  getStats(): Promise<StatsReportLike>;
}

export interface SessionVoice {
  getState(): VoiceClientState;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  join(): Promise<void>;
  leave(): void;
}

export interface SessionCamera {
  getState(): CameraClientState;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  setNetwork(network: NetworkQuality): void;
}

export interface RoomSessionParts<
  C extends SessionConnection = SessionConnection,
  R extends SessionRtc = SessionRtc,
  V extends SessionVoice = SessionVoice,
  K extends SessionCamera = SessionCamera,
> {
  connection: C;
  rtc: R;
  voice: V;
  camera: K;
  /** The voice part of the connection, for the camera client and the page. */
  signal: VoiceSignal;
}

/** Where the room page is, for "go to the room" from the voice panel. */
export type RoomLink =
  | { to: '/s/$spaceSlug/r/$roomSlug'; params: { spaceSlug: string; roomSlug: string } }
  | { to: '/rooms/$roomId'; params: { roomId: string } };

/** The window events the session listens to (pagehide, pageshow, online). */
export type WindowLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** Turns the cameras down on a bad network (voice/network.ts). */
export type NetworkMeterLike = Pick<NetworkMeter, 'sample' | 'update'>;

export interface RoomSessionOptions<P extends RoomSessionParts> {
  roomId: string;
  parts: P;
  /** Fake media (development): no SFU session. */
  fake: boolean;
  window: WindowLike | null;
  createMeter: () => NetworkMeterLike;
  /** How often the SFU stats are read for the cameras while in voice. */
  networkSampleMs?: number;
}

const NETWORK_SAMPLE_MS = 3_000;

/** One room's connection and media, started while someone holds it. */
export class RoomSession<P extends RoomSessionParts = RoomSessionParts> {
  readonly roomId: string;
  readonly parts: P;
  /** The page's link to the room, from the last page that showed it. */
  link: RoomLink | null = null;
  /** The room's name, from the REST answer until the socket says. */
  nameHint: string | null = null;
  private hint: RoomSettings | null = null;
  private started = false;
  private readonly running = { rtc: false, voice: false, camera: false };
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private readonly unsubscribers: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly options: RoomSessionOptions<P>;

  constructor(options: RoomSessionOptions<P>) {
    this.options = options;
    this.roomId = options.roomId;
    this.parts = options.parts;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** The room's name: the socket's, else the page's. */
  get name(): string {
    return this.parts.connection.getState().room?.name ?? this.nameHint ?? '';
  }

  /** What the room has: the socket's settings, else the page's REST answer, else unknown. */
  get settings(): RoomSettings | null {
    return this.parts.connection.getState().settings ?? this.hint;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Opens the room socket, and the media the room's settings call for. `start()` again is fine. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const { connection, voice } = this.parts;
    connection.start();
    this.unsubscribers.push(connection.subscribe(() => this.sync()));
    this.unsubscribers.push(voice.subscribe(() => this.sync()));
    const win = this.options.window;
    if (win) {
      // Back online: try at once instead of waiting out the backoff.
      const online = () => {
        if (connection.getState().status === 'reconnecting') connection.reconnect();
      };
      // The SFU session is closed with a beacon when the tab goes away, opened again when the
      // page comes back from the back/forward cache.
      const hide = () => {
        if (this.running.rtc) this.parts.rtc.close();
      };
      const show = (event: Event) => {
        if ((event as PageTransitionEvent).persisted && this.running.rtc) this.parts.rtc.start();
      };
      win.addEventListener('online', online);
      win.addEventListener('pagehide', hide);
      win.addEventListener('pageshow', show);
      this.unsubscribers.push(() => {
        win.removeEventListener('online', online);
        win.removeEventListener('pagehide', hide);
        win.removeEventListener('pageshow', show);
      });
    }
    this.sync();
  }

  /** Leaves voice and closes everything. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.setMeter(false);
    if (this.running.camera) this.parts.camera.stop();
    if (this.running.voice) this.parts.voice.stop();
    if (this.running.rtc) this.parts.rtc.close();
    this.running.camera = this.running.voice = this.running.rtc = false;
    this.parts.connection.stop();
    this.emit();
  }

  /** What the page knows of the room: its name and link, for the voice panel. */
  describe(name: string | null, link: RoomLink | null): void {
    this.nameHint = name;
    if (link) this.link = link;
  }

  /** The page's REST answer, used until the socket says what the room has. */
  setHint(settings: RoomSettings | null): void {
    if (settings === this.hint) return;
    this.hint = settings;
    this.sync();
  }

  /** Starts or stops each part from the room's settings and the voice. */
  private sync(): void {
    if (!this.started) return;
    const wants = this.wants();
    this.toggle('rtc', wants.rtc);
    this.toggle('voice', wants.voice);
    this.toggle('camera', wants.camera);
    this.setMeter(this.running.camera && this.parts.voice.getState().phase === 'joined');
    this.emit();
  }

  private toggle(part: 'rtc' | 'voice' | 'camera', on: boolean): void {
    if (this.running[part] === on) return;
    if (on) {
      this.running[part] = true;
      this.parts[part].start();
      return;
    }
    // Off once the room's message is fully taken in: the clients read why they are out (voice
    // turned off) before they stop.
    queueMicrotask(() => {
      if (!this.started || !this.running[part] || this.wants()[part]) return;
      this.running[part] = false;
      if (part === 'rtc') this.parts.rtc.close();
      else this.parts[part].stop();
      this.sync();
    });
  }

  /** Which parts the room's settings call for. */
  private wants(): Record<'rtc' | 'voice' | 'camera', boolean> {
    const settings = this.settings;
    const known = settings !== null;
    const c = capabilitiesOf(settings);
    return {
      // The SFU session connects before any click, once the room has streams or voice.
      rtc: !this.options.fake && known && (c.stream || c.voice),
      // Turning the room's voice off stops the client, which leaves.
      voice: known && c.voice,
      camera: known && c.voice && c.camera,
    };
  }

  /** While in voice with cameras, the session's stats every few seconds (camera.ts). */
  private setMeter(on: boolean): void {
    if (on === (this.meterTimer !== null)) return;
    if (this.meterTimer !== null) {
      clearInterval(this.meterTimer);
      this.meterTimer = null;
      this.parts.camera.setNetwork('good');
      return;
    }
    const meter = this.options.createMeter();
    this.meterTimer = setInterval(() => {
      this.parts.rtc.getStats().then(
        (stats) => this.parts.camera.setNetwork(meter.update(meter.sample(stats))),
        () => undefined,
      );
    }, this.options.networkSampleMs ?? NETWORK_SAMPLE_MS);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Why the voice ended in a room nobody was looking at, said once by the app. */
export type VoiceEndNotice =
  | { kind: 'removed'; room: string; reason: Exclude<VoiceLeftReason, 'left' | 'disconnected'> }
  | { kind: 'ended'; room: string; reason: EndReason };

export interface VoiceSessionsState<S> {
  /** The room this tab is in voice in (joining or joined); null while out of voice. */
  active: S | null;
  /** Joining voice in `to` while in `from`: waiting for "Switch to <room>?". */
  pendingSwitch: { from: S; to: S } | null;
  notice: VoiceEndNotice | null;
  /** The rooms a page shows now, by id. */
  viewing: readonly string[];
}

/**
 * The room sessions of this tab, by room id: held by the pages showing them and by the voice. The
 * app shell keeps one (VoiceSessionProvider).
 */
export class VoiceSessions<P extends RoomSessionParts = RoomSessionParts> {
  private readonly sessions = new Map<string, RoomSession<P>>();
  private readonly views = new Map<RoomSession<P>, number>();
  private readonly voiceUnsubscribers = new Map<RoomSession<P>, () => void>();
  private state: VoiceSessionsState<RoomSession<P>> = {
    active: null,
    pendingSwitch: null,
    notice: null,
    viewing: [],
  };
  private readonly listeners = new Set<() => void>();
  /** Leaving on purpose (disconnect, switch): no notice. */
  private leaving = false;

  constructor(private readonly create: (roomId: string) => RoomSession<P>) {}

  getState = (): VoiceSessionsState<RoomSession<P>> => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The room's session: the one already open (in voice), else a new one; opens nothing. */
  get(roomId: string): RoomSession<P> {
    let session = this.sessions.get(roomId);
    if (!session) {
      session = this.create(roomId);
      this.sessions.set(roomId, session);
    }
    return session;
  }

  /** The sessions open now: the rooms pages show, and the voice's (notices/AppNotices.tsx). */
  openSessions(): RoomSession<P>[] {
    const open = new Set(this.views.keys());
    if (this.state.active) open.add(this.state.active);
    return [...open];
  }

  /** Whether a page shows the room now. */
  isViewed(session: RoomSession<P>): boolean {
    return (this.views.get(session) ?? 0) > 0;
  }

  /** A page shows the room: starts its session until the returned release (StrictMode-safe). */
  view(session: RoomSession<P>): () => void {
    const current = this.sessions.get(session.roomId);
    if (current !== session && (!current || !current.isStarted)) {
      this.sessions.set(session.roomId, session);
    }
    this.views.set(session, (this.views.get(session) ?? 0) + 1);
    this.open(session);
    this.setViewing();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.views.get(session) ?? 1) - 1;
      if (count > 0) this.views.set(session, count);
      else this.views.delete(session);
      this.closeIfUnused(session);
      this.setViewing();
    };
  }

  /**
   * Join voice in this room. While in voice in another one, asks first ("Switch to <room>?");
   * `confirmSwitch` leaves that one and joins here.
   */
  requestJoin(session: RoomSession<P>): void {
    const active = this.state.active;
    if (active && active !== session) {
      this.set({ pendingSwitch: { from: active, to: session } });
      return;
    }
    void session.parts.voice.join();
  }

  confirmSwitch(): void {
    const pending = this.state.pendingSwitch;
    if (!pending) return;
    this.set({ pendingSwitch: null });
    this.leaveSession(pending.from);
    if (pending.to.isStarted) void pending.to.parts.voice.join();
  }

  cancelSwitch(): void {
    if (this.state.pendingSwitch) this.set({ pendingSwitch: null });
  }

  /** The voice panel's disconnect. */
  leave(): void {
    if (this.state.active) this.leaveSession(this.state.active);
  }

  dismissNotice(): void {
    if (this.state.notice) this.set({ notice: null });
  }

  /** Closes everything (the app went away). */
  dispose(): void {
    for (const session of new Set([...this.sessions.values(), ...this.views.keys()])) {
      this.close(session);
    }
    this.views.clear();
    this.set({ active: null, pendingSwitch: null, viewing: [] });
  }

  private leaveSession(session: RoomSession<P>): void {
    this.leaving = true;
    try {
      session.parts.voice.leave();
    } finally {
      this.leaving = false;
    }
  }

  private open(session: RoomSession<P>): void {
    if (!this.voiceUnsubscribers.has(session)) {
      this.voiceUnsubscribers.set(
        session,
        session.parts.voice.subscribe(() => this.onVoice(session)),
      );
    }
    session.start();
  }

  private close(session: RoomSession<P>): void {
    this.voiceUnsubscribers.get(session)?.();
    this.voiceUnsubscribers.delete(session);
    session.stop();
    if (this.sessions.get(session.roomId) === session) this.sessions.delete(session.roomId);
  }

  private closeIfUnused(session: RoomSession<P>): void {
    if (this.isViewed(session) || this.state.active === session) return;
    if (this.state.pendingSwitch?.to === session) this.set({ pendingSwitch: null });
    this.close(session);
  }

  private onVoice(session: RoomSession<P>): void {
    const phase = session.parts.voice.getState().phase;
    const active = this.state.active;
    if (phase !== 'idle') {
      if (active === session) return;
      // One room in voice at a time, however the join came.
      if (active) this.leaveSession(active);
      this.set({ active: session, notice: null });
      return;
    }
    if (active !== session) return;
    this.set({ active: null });
    // Out on its own (not the user's leave) in a room nobody shows: say why. The room's reason
    // may come in the same message, after the client stopped (voice turned off), so it is read
    // once that update is done, and the room is closed then too.
    const silent = this.leaving || this.isViewed(session);
    queueMicrotask(() => {
      if (!silent) {
        const notice = this.endNotice(session);
        if (notice) this.set({ notice });
      }
      this.closeIfUnused(session);
    });
  }

  private endNotice(session: RoomSession<P>): VoiceEndNotice | null {
    const room = session.parts.connection.getState();
    const left = room.voice.left;
    const removed =
      session.parts.voice.getState().removed ??
      (left !== null && left !== 'left' && left !== 'disconnected' ? left : null);
    if (removed) return { kind: 'removed', room: session.name, reason: removed };
    if (room.ended) return { kind: 'ended', room: session.name, reason: room.ended };
    return null;
  }

  private setViewing(): void {
    const viewing = [...new Set([...this.views.keys()].map((s) => s.roomId))].sort();
    if (viewing.join() !== this.state.viewing.join()) this.set({ viewing });
  }

  private set(patch: Partial<VoiceSessionsState<RoomSession<P>>>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
