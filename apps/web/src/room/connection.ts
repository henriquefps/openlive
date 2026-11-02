// SPDX-License-Identifier: AGPL-3.0-only
import type {
  CloseCode,
  ErrorCode,
  ErrorPayload,
  HelloMessage,
  KickReason,
  Member,
  Message,
  ProtocolVersion,
  RoomCloseReason,
  RoomInfo,
  RoomSettings,
  StreamEndReason,
  StreamInfo,
  ViewersPayload,
  You,
} from '@openlive/protocol';
import { version as CLIENT_VERSION } from '../../package.json';
import type { SignalVoice } from '../voice/client.ts';
import type { VoiceOutgoing, VoiceParticipant } from '../voice/contract.ts';

// The web side of the room socket (docs/PROTOCOL.md 4, 5, 7.1): hello → welcome, live presence,
// permission changes, kicks and closes, reconnect with backoff, ping keepalive, and the voice
// channel's signalling (voice/contract.ts): who is in voice, their state, the tracks to pull.
// Other features on the same socket (the text chat, chat/client.ts) `listen` to every message and
// send their own requests with `request`.
//
// Only types come from @openlive/protocol: a runtime import would bundle its validators (ajv).
// The few constants needed here are copied, and test/room-connection.test.ts checks them against
// the package. Incoming frames are trusted to follow the schema (the RoomDO validates what it
// sends), so they only get a shape check.

/** Same bytes as PING_FRAME in @openlive/protocol: the DO answers without waking up. */
export const PING_FRAME = '{"type":"ping","payload":{}}';
export const PROTOCOL: ProtocolVersion = { major: 1, minor: 20 };
export const CLOSE = {
  Unauthenticated: 4001,
  Replaced: 4002,
  Forbidden: 4003,
  Kicked: 4004,
  RoomClosed: 4005,
  ProtocolUnsupported: 4006,
} as const satisfies Record<string, CloseCode>;

export const PING_INTERVAL_MS = 30_000;
/** No welcome this long after hello: give up on this socket and reconnect. */
export const WELCOME_TIMEOUT_MS = 10_000;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 30_000;

/** Why the connection stopped for good; none of these reconnect by themselves (PROTOCOL 5). */
export type EndReason =
  | { kind: 'kicked'; reason: KickReason }
  | { kind: 'closed'; reason: RoomCloseReason }
  | { kind: 'forbidden' }
  | { kind: 'unauthenticated' }
  /** The same tab connected again (4002); the user can bring this one back. */
  | { kind: 'replaced' }
  /** The server no longer speaks this protocol version (4006): reload for a newer app. */
  | { kind: 'reload' };

export type RoomStatus = 'connecting' | 'open' | 'reconnecting' | 'ended';

/** This tab's way to a stream's viewer slot (PROTOCOL 7.3); absent while not watching it. */
export type WatchAccess =
  | { kind: 'requesting' }
  | { kind: 'granted'; slotId: string; expiresAt: number; leaseMs: number }
  /** No free slot. `queue` is null until the viewer joins the queue. */
  | { kind: 'full'; queue: { position: number; length: number } | 'joining' | null }
  /** A slot freed up for this viewer: accept before `expiresAt` (30 s). */
  | { kind: 'offer'; offerId: string; expiresAt: number }
  | { kind: 'denied'; code: ErrorCode };

export interface RoomState {
  status: RoomStatus;
  /** Failed attempts since the last welcome; 0 while open. */
  attempt: number;
  you: You | null;
  room: RoomInfo | null;
  settings: RoomSettings | null;
  /** Present users, one entry each, in arrival order. */
  members: Member[];
  streams: StreamInfo[];
  /** The latest `viewers` broadcast per stream id. */
  viewers: Record<string, ViewersPayload>;
  /** Slot or queue state of the streams this tab watches, by stream id. */
  access: Record<string, WatchAccess>;
  /** Why streams ended while this page was open, by stream id, for the player's ended screen. */
  endedStreams: Record<string, StreamEndReason>;
  /** The room's hard expiry (quick rooms), corrected for clock skew. */
  expiresAt: number | null;
  ended: EndReason | null;
  /** The last error message the room sent. */
  error: ErrorPayload | null;
  /** The last close was do_quota_exceeded: the instance is down until Cloudflare lifts the limit. */
  quotaExceeded: boolean;
  /** The voice channel: who is in it, and this connection's place in it. */
  voice: SignalVoice;
}

export const INITIAL_VOICE: SignalVoice = {
  self: 'out',
  selfId: null,
  canSpeak: true,
  participants: [],
  tracks: [],
  cameras: [],
  canUseCamera: false,
  cameraStopped: null,
  error: null,
  left: null,
};

export const INITIAL_STATE: RoomState = {
  status: 'connecting',
  attempt: 0,
  you: null,
  room: null,
  settings: null,
  members: [],
  streams: [],
  viewers: {},
  access: {},
  endedStreams: {},
  expiresAt: null,
  ended: null,
  error: null,
  quotaExceeded: false,
  voice: INITIAL_VOICE,
};

/** The subset of the browser WebSocket the connection uses, so tests can pass a fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ConnectionOptions {
  url: string;
  tabId: string;
  createSocket?: (url: string) => SocketLike;
  /** Random source for the backoff jitter, [0, 1). */
  random?: () => number;
  now?: () => number;
}

const OPEN = 1;

/** A random id for this browser tab, kept for the page's lifetime (hello.tabId). */
export const TAB_ID = `t_${crypto.randomUUID()}`;

/** The socket URL for a room, on this page's origin (Vite proxies /ws in development). */
export function roomSocketUrl(roomId: string, location: Location = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws/rooms/${encodeURIComponent(roomId)}`;
}

/** Full-jitter exponential backoff: between half and all of min(max, base · 2^attempt). */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/**
 * The close code of a socket the Worker refused because the instance used up a daily Cloudflare
 * free-tier limit of Durable Objects (do_quota_exceeded, PROTOCOL 1.15): standard
 * 1013 "try again later".
 */
export const QUOTA_CLOSE = 1013;
/**
 * After a QUOTA_CLOSE, the next try waits this long (plus jitter): Cloudflare documents a reset at
 * 00:00 UTC, but a block has outlasted it, so the room keeps trying.
 */
export const QUOTA_RETRY_MS = 15 * 60_000;

/** How long to wait before reconnecting after a close with `code`. */
export function retryDelay(code: number, attempt: number, random: () => number = Math.random) {
  if (code === QUOTA_CLOSE) return Math.round(QUOTA_RETRY_MS * (1 + random() * 0.2));
  return backoffDelay(attempt, random);
}

function parse(data: unknown): Message | null {
  if (typeof data !== 'string') return null;
  try {
    const value: unknown = JSON.parse(data);
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { type?: unknown }).type === 'string' &&
      typeof (value as { payload?: unknown }).payload === 'object'
    ) {
      return value as Message;
    }
  } catch {
    // Not JSON: ignored like an unknown message.
  }
  return null;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

/** Permissions.canSpeak (protocol 1.10); an older server leaves it out. */
const canSpeak = (you: You): boolean => you.permissions.canSpeak !== false;

/** Permissions.canUseCamera (protocol 1.12); an older server has no cameras. */
const canUseCamera = (you: You): boolean => you.permissions.canUseCamera === true;

function upsertParticipant(
  participants: VoiceParticipant[],
  participant: VoiceParticipant,
): VoiceParticipant[] {
  const index = participants.findIndex((p) => p.userId === participant.userId);
  if (index === -1) return [...participants, participant];
  return participants.map((p, i) => (i === index ? participant : p));
}

function upsert(members: Member[], member: Member): Member[] {
  const index = members.findIndex((m) => m.userId === member.userId);
  if (index === -1) return [...members, member];
  return members.map((m, i) => (i === index ? member : m));
}

export class RoomConnection {
  private state: RoomState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private socket: SocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the room told us just before it closes the socket (kicked, room.closed, error). */
  private pendingEnd: EndReason | null = null;
  private stopped = false;
  private nextId = 1;
  /** Streams this tab wants to watch; their slots are requested again after a reconnect. */
  private readonly watching = new Set<string>();
  /** Slot renewal timers by stream id (every leaseMs / 3). */
  private readonly renewTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Requests sent with an id whose error reply concerns a stream: id → stream id. */
  private readonly pending = new Map<string, string>();
  /** This tab wants to be in voice: joined again after a reconnect, until `leaveVoice`. */
  private voiceWanted = false;
  /** The id of the voice.join waiting for its answer. */
  private voiceJoinId: string | null = null;
  /** Mute and deafen to join with (again, after a reconnect). */
  private voiceJoinState: VoiceOutgoing['voice.join'] = {};
  /** Every message, after the connection handled it (chat/client.ts). */
  private readonly messageListeners = new Set<(message: Message) => void>();
  private readonly createSocket: (url: string) => SocketLike;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly options: ConnectionOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  getState = (): RoomState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Hears every message the room sends, after the connection's own state took it in. */
  listen = (listener: (message: Message) => void): (() => void) => {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  };

  /** Sends a request with a fresh id and returns the id; null while the room is not open. */
  sendRequest(type: string, payload: object): string | null {
    if (!this.socket || this.socket.readyState !== OPEN || this.state.status !== 'open')
      return null;
    const id = String(this.nextId++);
    this.send(type, payload, id);
    return id;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Closes the socket and stops reconnecting (the page went away). */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close(1000);
    }
  }

  /** Connects again now: after "replaced", or to skip the backoff wait. */
  reconnect(): void {
    if (this.stopped) return;
    this.clearTimers();
    if (this.socket) return;
    this.set({ ended: null, error: null });
    this.connect();
  }

  /** Asks for a viewer slot (PROTOCOL 7.3); kept across reconnects until `unwatch`. */
  watch(streamId: string): void {
    this.watching.add(streamId);
    const current = this.state.access[streamId];
    if (current && current.kind !== 'denied') return;
    this.setAccess(streamId, { kind: 'requesting' });
    this.request('slot.request', { streamId }, streamId);
  }

  /** Gives the slot back, or leaves the queue. */
  unwatch(streamId: string): void {
    this.watching.delete(streamId);
    this.stopRenew(streamId);
    const access = this.state.access[streamId];
    if (access?.kind === 'granted') this.send('slot.release', { slotId: access.slotId });
    if (access?.kind === 'full' && access.queue !== null) this.send('queue.leave', { streamId });
    if (access?.kind === 'offer') this.send('queue.leave', { streamId });
    this.set({ access: without(this.state.access, streamId) });
  }

  joinQueue(streamId: string): void {
    const access = this.state.access[streamId];
    if (access?.kind !== 'full' || access.queue !== null) return;
    this.setAccess(streamId, { kind: 'full', queue: 'joining' });
    this.request('queue.join', { streamId }, streamId);
  }

  leaveQueue(streamId: string): void {
    const access = this.state.access[streamId];
    if (access?.kind !== 'full' && access?.kind !== 'offer') return;
    this.send('queue.leave', { streamId });
    this.setAccess(streamId, { kind: 'full', queue: null });
  }

  acceptOffer(streamId: string): void {
    const access = this.state.access[streamId];
    if (access?.kind !== 'offer') return;
    this.setAccess(streamId, { kind: 'requesting' });
    this.request('queue.accept', { offerId: access.offerId }, streamId);
  }

  /**
   * Joins the room's voice channel from this tab (PROTOCOL 7.5): the voice.joined that answers
   * the request's id puts this tab in. Joined again after a reconnect, until `leaveVoice`.
   */
  joinVoice(state: VoiceOutgoing['voice.join'] = {}): void {
    this.voiceWanted = true;
    this.voiceJoinState = state;
    if (this.state.voice.self !== 'out') return;
    this.setVoice({ self: 'joining', error: null, left: null });
    this.sendJoin();
  }

  leaveVoice(): void {
    this.voiceWanted = false;
    this.voiceJoinId = null;
    if (this.state.voice.self === 'out') return;
    this.sendVoice('voice.leave', {});
    this.setVoice({ self: 'out', tracks: [], cameras: [], left: 'left' });
  }

  setVoiceState(state: VoiceOutgoing['voice.state']): void {
    this.voiceJoinState = state;
    if (this.state.voice.self === 'in') this.sendVoice('voice.state', state);
  }

  /** Owner or admin: mutes someone for everyone, or lifts it. */
  serverMute(userId: string, muted: boolean): void {
    this.sendVoice('voice.serverMute', { userId, muted });
  }

  /** Owner or admin: takes someone out of voice. */
  kickFromVoice(userId: string): void {
    this.sendVoice('voice.kick', { userId });
  }

  /** Owner or admin: turns someone's camera off (PROTOCOL 7.7). */
  cameraOff(userId: string): void {
    this.sendVoice('voice.cameraOff', { userId });
  }

  private sendJoin(): void {
    const id = String(this.nextId++);
    this.voiceJoinId = id;
    this.sendVoice('voice.join', this.voiceJoinState, id);
  }

  private sendVoice<T extends keyof VoiceOutgoing>(
    type: T,
    payload: VoiceOutgoing[T],
    id?: string,
  ): void {
    this.send(type, payload, id);
  }

  private setVoice(patch: Partial<SignalVoice>): void {
    this.set({ voice: { ...this.state.voice, ...patch } });
  }

  /** The voice.* messages (PROTOCOL 7.5); true when the message was one. */
  private onVoiceMessage(message: Message): boolean {
    const voice = this.state.voice;
    switch (message.type) {
      case 'voice.joined':
      case 'voice.updated': {
        const { participant } = message.payload;
        const participants = upsertParticipant(voice.participants, participant);
        // The answer to this tab's join (a voice.joined of the same user without the id is
        // another tab of theirs).
        // A late answer after leaveVoice() matches nothing: the room handles the leave after it.
        if (message.id !== undefined && message.id === this.voiceJoinId) {
          this.voiceJoinId = null;
          this.setVoice({ participants, self: 'in', error: null, left: null });
        } else this.setVoice({ participants });
        return true;
      }
      case 'voice.left': {
        const { userId, reason } = message.payload;
        // Moved to another tab of the same user: they are still in voice, from there.
        const participants =
          reason === 'moved'
            ? voice.participants
            : voice.participants.filter((p) => p.userId !== userId);
        if (userId === voice.selfId && voice.self !== 'out' && reason !== 'left') {
          // Taken out (kicked, removed, moved, voice turned off): not joined again.
          this.voiceWanted = false;
          this.voiceJoinId = null;
          this.setVoice({ participants, self: 'out', tracks: [], cameras: [], left: reason });
        } else this.setVoice({ participants });
        return true;
      }
      case 'voice.tracks': {
        const { tracks, cameras = [] } = message.payload;
        if (voice.self === 'in') this.setVoice({ tracks, cameras });
        return true;
      }
      case 'voice.cameraStopped':
        this.setVoice({
          cameraStopped: {
            reason: message.payload.reason,
            seq: (voice.cameraStopped?.seq ?? 0) + 1,
          },
        });
        return true;
      default:
        return false;
    }
  }

  private send(type: string, payload: object, id?: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || this.state.status !== 'open') return;
    socket.send(JSON.stringify(id === undefined ? { type, payload } : { type, id, payload }));
  }

  private request(type: string, payload: object, streamId: string): void {
    const id = String(this.nextId++);
    this.pending.set(id, streamId);
    this.send(type, payload, id);
  }

  private setAccess(streamId: string, access: WatchAccess): void {
    this.set({ access: { ...this.state.access, [streamId]: access } });
  }

  private startRenew(streamId: string, slotId: string, leaseMs: number): void {
    this.stopRenew(streamId);
    const timer = setInterval(
      () => this.send('slot.renew', { slotId }),
      Math.max(1_000, Math.floor(leaseMs / 3)),
    );
    this.renewTimers.set(streamId, timer);
  }

  private stopRenew(streamId: string): void {
    const timer = this.renewTimers.get(streamId);
    if (timer !== undefined) clearInterval(timer);
    this.renewTimers.delete(streamId);
  }

  /** A stream left the room: nothing to watch or wait for any more. */
  private forget(streamId: string): void {
    this.watching.delete(streamId);
    this.stopRenew(streamId);
    this.set({
      access: without(this.state.access, streamId),
      viewers: without(this.state.viewers, streamId),
    });
  }

  private set(patch: Partial<RoomState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private clearTimers(): void {
    for (const timer of this.renewTimers.values()) clearInterval(timer);
    this.renewTimers.clear();
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer);
    this.pingTimer = this.retryTimer = this.welcomeTimer = null;
  }

  private connect(): void {
    this.pendingEnd = null;
    this.set({ status: this.state.attempt === 0 ? 'connecting' : 'reconnecting' });
    const socket = this.createSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      const hello: HelloMessage = {
        type: 'hello',
        id: String(this.nextId++),
        payload: {
          protocol: PROTOCOL,
          client: 'web',
          clientVersion: CLIENT_VERSION,
          tabId: this.options.tabId,
        },
      };
      socket.send(JSON.stringify(hello));
      this.welcomeTimer = setTimeout(() => {
        // The browser reports this close as 1000 or 1005; either way it is a reconnect.
        socket.close();
        this.onClose(socket, 1006);
      }, WELCOME_TIMEOUT_MS);
      this.pingTimer = setInterval(() => {
        if (socket.readyState === OPEN) socket.send(PING_FRAME);
      }, PING_INTERVAL_MS);
    };
    socket.onmessage = (event) => {
      const message = parse(event.data);
      if (!message) return;
      this.onMessage(message);
      for (const listener of this.messageListeners) listener(message);
    };
    socket.onclose = (event) => this.onClose(socket, event.code);
  }

  private onMessage(message: Message): void {
    if (this.onVoiceMessage(message)) return;
    switch (message.type) {
      case 'welcome': {
        const { you, room, settings, members, streams, serverTime } = message.payload;
        const skew = serverTime - this.now();
        if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer);
        this.welcomeTimer = null;
        this.set({
          status: 'open',
          attempt: 0,
          quotaExceeded: false,
          you,
          room,
          settings,
          members,
          streams,
          expiresAt: room.expiresAt === undefined ? null : room.expiresAt - skew,
          viewers: {},
          // Closing the socket released every slot: ask again for the streams still here.
          access: {},
          ended: null,
          error: null,
        });
        this.pending.clear();
        // Who is in voice (the socket closing took this tab out): join again if it was in.
        const inVoice = message.payload.voice;
        this.voiceJoinId = null;
        this.set({
          voice: {
            ...INITIAL_VOICE,
            selfId: you.userId,
            canSpeak: canSpeak(you),
            canUseCamera: canUseCamera(you),
            participants: inVoice ?? [],
            self: this.voiceWanted ? 'joining' : 'out',
          },
        });
        if (this.voiceWanted) {
          if (settings.capabilities?.voice === false) {
            this.voiceWanted = false;
            this.setVoice({ self: 'out', left: 'capability_disabled' });
          } else this.sendJoin();
        }
        for (const streamId of [...this.watching]) {
          if (streams.some((s) => s.streamId === streamId)) this.watch(streamId);
          else this.watching.delete(streamId);
        }
        return;
      }
      case 'member.joined':
      case 'member.updated':
        this.set({ members: upsert(this.state.members, message.payload.member) });
        return;
      case 'member.left':
        this.set({
          members: this.state.members.filter((m) => m.userId !== message.payload.userId),
        });
        return;
      case 'permissions.changed':
        this.set({ you: message.payload.you });
        this.setVoice({
          canSpeak: canSpeak(message.payload.you),
          canUseCamera: canUseCamera(message.payload.you),
        });
        return;
      case 'kicked':
        this.pendingEnd = { kind: 'kicked', reason: message.payload.reason };
        return;
      case 'room.closed':
        this.pendingEnd = { kind: 'closed', reason: message.payload.reason };
        return;
      case 'room.expiring':
        this.set({ expiresAt: message.payload.expiresAt });
        return;
      case 'room.updated':
        // New limits or capabilities (PROTOCOL.md 7.4): the room re-renders from them.
        this.set({ settings: message.payload.settings });
        // Voice turned off: the room sent voice.left to everyone first; nobody is left in it.
        if (message.payload.settings.capabilities?.voice === false) {
          this.voiceWanted = false;
          const wasIn = this.state.voice.self !== 'out';
          this.setVoice({
            self: 'out',
            participants: [],
            tracks: [],
            cameras: [],
            ...(wasIn ? { left: 'capability_disabled' as const } : {}),
          });
        }
        return;
      case 'stream.started':
      case 'stream.updated': {
        const { stream } = message.payload;
        const others = this.state.streams.filter((s) => s.streamId !== stream.streamId);
        this.set({ streams: [...others, stream] });
        return;
      }
      case 'stream.ended': {
        const { streamId, reason } = message.payload;
        this.forget(streamId);
        this.set({
          streams: this.state.streams.filter((s) => s.streamId !== streamId),
          endedStreams: { ...this.state.endedStreams, [streamId]: reason },
        });
        return;
      }
      case 'viewers':
        this.set({
          viewers: { ...this.state.viewers, [message.payload.streamId]: message.payload },
        });
        return;
      case 'slot.granted': {
        const { slotId, streamId, expiresAt, leaseMs } = message.payload;
        const held = this.state.access[streamId];
        if (!this.watching.has(streamId) || (held?.kind === 'granted' && held.slotId !== slotId)) {
          // Granted after the viewer left (a late reply or a queue offer), or a second grant for
          // a stream already held (a repeated request): give it back.
          this.send('slot.release', { slotId });
          return;
        }
        this.setAccess(streamId, { kind: 'granted', slotId, expiresAt, leaseMs });
        this.startRenew(streamId, slotId, leaseMs);
        return;
      }
      case 'slot.renewed': {
        const { slotId, expiresAt } = message.payload;
        for (const [streamId, access] of Object.entries(this.state.access)) {
          if (access.kind === 'granted' && access.slotId === slotId) {
            this.setAccess(streamId, { ...access, expiresAt });
          }
        }
        return;
      }
      case 'slot.released': {
        const { streamId, reason } = message.payload;
        this.stopRenew(streamId);
        if (reason === 'stream_ended' || !this.watching.has(streamId)) {
          this.set({ access: without(this.state.access, streamId) });
        } else if (reason === 'access_revoked') {
          this.setAccess(streamId, { kind: 'denied', code: 'forbidden' });
        } else {
          // Lease expired (a long freeze of the tab) or released elsewhere: ask again.
          this.set({ access: without(this.state.access, streamId) });
          this.watch(streamId);
        }
        return;
      }
      case 'queue.position': {
        const { streamId, position, length } = message.payload;
        if (this.watching.has(streamId)) {
          this.setAccess(streamId, { kind: 'full', queue: { position, length } });
        }
        return;
      }
      case 'queue.offer': {
        const { streamId, offerId, expiresAt } = message.payload;
        if (this.watching.has(streamId))
          this.setAccess(streamId, { kind: 'offer', offerId, expiresAt });
        return;
      }
      case 'queue.left': {
        const { streamId, reason } = message.payload;
        if (!this.watching.has(streamId)) return;
        if (reason === 'access_revoked')
          this.setAccess(streamId, { kind: 'denied', code: 'forbidden' });
        else if (reason === 'stream_ended') this.forget(streamId);
        else this.setAccess(streamId, { kind: 'full', queue: null });
        return;
      }
      case 'error': {
        if (message.payload.code === 'protocol_unsupported') this.pendingEnd = { kind: 'reload' };
        if (message.id !== undefined && message.id === this.voiceJoinId) {
          this.voiceJoinId = null;
          this.voiceWanted = false;
          this.setVoice({ self: 'out', error: message.payload });
        }
        const streamId = message.id === undefined ? undefined : this.pending.get(message.id);
        if (message.id !== undefined) this.pending.delete(message.id);
        if (streamId !== undefined && this.watching.has(streamId)) {
          this.onWatchError(streamId, message.payload.code);
        }
        this.set({ error: message.payload });
        return;
      }
      case 'ack':
        if (message.id !== undefined) this.pending.delete(message.id);
        return;
      default:
        // Unknown types are ignored (PROTOCOL 3).
        return;
    }
  }

  private onWatchError(streamId: string, code: ErrorCode): void {
    switch (code) {
      case 'viewer_limit_reached':
        this.setAccess(streamId, { kind: 'full', queue: null });
        return;
      case 'offer_not_found':
        // The offer ran out or went to someone else: back in front of the queue button.
        this.setAccess(streamId, { kind: 'full', queue: null });
        return;
      case 'stream_not_found':
        this.forget(streamId);
        return;
      default:
        this.setAccess(streamId, { kind: 'denied', code });
    }
  }

  private onClose(socket: SocketLike, code: number): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearTimers();
    if (this.stopped) return;
    const ended = this.endReason(code);
    if (ended) {
      this.voiceWanted = false;
      this.set({
        status: 'ended',
        ended,
        members: [],
        streams: [],
        viewers: {},
        access: {},
        voice: { ...INITIAL_VOICE, selfId: this.state.voice.selfId, left: 'disconnected' },
      });
      return;
    }
    // 1006 (network, refused upgrade), 1000/1001 during a deploy, anything else: try again.
    const attempt = this.state.attempt;
    this.pending.clear();
    this.set({
      status: 'reconnecting',
      attempt: attempt + 1,
      quotaExceeded: code === QUOTA_CLOSE,
      access: {},
      // The room took this tab out of voice with the socket; the welcome joins again.
      voice: {
        ...INITIAL_VOICE,
        selfId: this.state.voice.selfId,
        self: this.voiceWanted ? 'joining' : 'out',
        left: 'disconnected',
      },
    });
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.connect();
      },
      retryDelay(code, attempt, this.random),
    );
  }

  private endReason(code: number): EndReason | null {
    switch (code) {
      case CLOSE.Unauthenticated:
        return { kind: 'unauthenticated' };
      case CLOSE.Replaced:
        return { kind: 'replaced' };
      case CLOSE.Forbidden:
        return { kind: 'forbidden' };
      case CLOSE.Kicked:
        return this.pendingEnd?.kind === 'kicked'
          ? this.pendingEnd
          : { kind: 'kicked', reason: 'removed' };
      case CLOSE.RoomClosed:
        return this.pendingEnd?.kind === 'closed'
          ? this.pendingEnd
          : { kind: 'closed', reason: 'archived' };
      case CLOSE.ProtocolUnsupported:
        return { kind: 'reload' };
      default:
        return null;
    }
  }
}
