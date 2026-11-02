// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ErrorPayload,
  HelloMessage,
  HelperInfo,
  HelperStatsPayload,
  HelperStatusPayload,
  Message,
  NoticePayload,
  PayloadOf,
} from '@openlive/protocol';
import { version as CLIENT_VERSION } from '../../package.json';
import {
  retryDelay,
  CLOSE,
  PING_FRAME,
  PING_INTERVAL_MS,
  PROTOCOL,
  type SocketLike,
  WELCOME_TIMEOUT_MS,
} from '../room/connection.ts';

// The web side of the user hub (docs/PROTOCOL.md 8): which of the user's helpers are online,
// their status and stats, and commands to them. Same handshake, keepalive and reconnect rules as
// the room socket (room/connection.ts). The hub rewrites ids between this tab and the helper, so
// replies come back under this tab's own ids.

/** Commands this tab sends to a helper through the hub (PROTOCOL.md 8.2). */
export type HubCommand =
  | 'helper.listSources'
  | 'helper.startStream'
  | 'helper.stopStream'
  | 'helper.pauseStream'
  | 'helper.setPreset'
  | 'helper.setVoiceOutput';

export type HubReply<T extends HubCommand> = T extends 'helper.listSources'
  ? PayloadOf<'helper.sources'>
  : PayloadOf<'ack'>;

/** A command's error reply, or a failure on this side (offline, timed out). */
export class HubError extends Error {
  constructor(readonly payload: ErrorPayload) {
    super(payload.code);
  }
}

/** A command the helper has not answered in this long fails (starting a stream takes seconds). */
export const COMMAND_TIMEOUT_MS = 30_000;

export type HubStatus = 'connecting' | 'open' | 'reconnecting' | 'ended';
/** Why the hub socket stopped for good (PROTOCOL 5). */
export type HubEnd = 'unauthenticated' | 'replaced' | 'reload';

export interface HubState {
  status: HubStatus;
  attempt: number;
  ended: HubEnd | null;
  /** The user's helpers that are online, by device id. */
  helpers: Record<string, HelperInfo>;
  /** The latest helper.status per device. */
  statuses: Record<string, HelperStatusPayload>;
  /** The latest helper.stats per device, while it streams. */
  stats: Record<string, HelperStatsPayload>;
  /**
   * Source picker thumbnails of the last listSources with thumbnails, as data: URLs, by
   * `deviceId/sourceId`. Kept in memory only.
   */
  thumbnails: Record<string, string>;
  /** The latest user notice (PROTOCOL.md 8.3), numbered so the same one twice is two. */
  notice: { seq: number; payload: NoticePayload } | null;
}

export const INITIAL_HUB_STATE: HubState = {
  status: 'connecting',
  attempt: 0,
  ended: null,
  helpers: {},
  statuses: {},
  stats: {},
  thumbnails: {},
  notice: null,
};

export const thumbnailKey = (deviceId: string, sourceId: string) => `${deviceId}/${sourceId}`;

export interface HubConnectionOptions {
  url: string;
  tabId: string;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
}

const OPEN = 1;

/** The hub socket URL on this page's origin (Vite proxies /ws in development). */
export function hubSocketUrl(location: Location = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws/hub`;
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

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (error: HubError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HubConnection {
  private state: HubState = INITIAL_HUB_STATE;
  private readonly listeners = new Set<() => void>();
  private socket: SocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly createSocket: (url: string) => SocketLike;
  private readonly random: () => number;

  constructor(private readonly options: HubConnectionOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.random = options.random ?? Math.random;
  }

  getState = (): HubState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    this.stopped = false;
    if (!this.socket && this.retryTimer === null) this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.failPending({ code: 'helper_offline' });
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
    this.set({ ended: null });
    this.connect();
  }

  /**
   * Sends a command to one of the user's helpers and resolves with its reply. Rejects with a
   * HubError: the helper's error, helper_offline when the hub socket is down or drops, or
   * internal_error after COMMAND_TIMEOUT_MS.
   */
  request<T extends HubCommand>(type: T, payload: PayloadOf<T>): Promise<HubReply<T>> {
    const deviceId = (payload as { deviceId: string }).deviceId;
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || this.state.status !== 'open') {
      return Promise.reject(new HubError({ code: 'helper_offline', deviceId }));
    }
    if (type === 'helper.listSources') this.clearThumbnails(deviceId);
    const id = String(this.nextId++);
    return new Promise<HubReply<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HubError({ code: 'internal_error' }));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (p: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ type, id, payload }));
    });
  }

  private set(patch: Partial<HubState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private clearThumbnails(deviceId: string): void {
    const prefix = `${deviceId}/`;
    this.set({
      thumbnails: Object.fromEntries(
        Object.entries(this.state.thumbnails).filter(([k]) => !k.startsWith(prefix)),
      ),
    });
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer);
    this.pingTimer = this.retryTimer = this.welcomeTimer = null;
  }

  private failPending(error: ErrorPayload): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new HubError(error));
    }
  }

  private connect(): void {
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
        socket.close();
        this.onClose(socket, 1006);
      }, WELCOME_TIMEOUT_MS);
      this.pingTimer = setInterval(() => {
        if (socket.readyState === OPEN) socket.send(PING_FRAME);
      }, PING_INTERVAL_MS);
    };
    socket.onmessage = (event) => {
      const message = parse(event.data);
      if (message) this.onMessage(message);
    };
    socket.onclose = (event) => this.onClose(socket, event.code);
  }

  private onMessage(message: Message): void {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.type === 'error') pending.reject(new HubError(message.payload));
        else pending.resolve(message.payload);
        return;
      }
    }
    switch (message.type) {
      case 'hub.welcome': {
        if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer);
        this.welcomeTimer = null;
        const helpers = Object.fromEntries(message.payload.helpers.map((h) => [h.deviceId, h]));
        // Statuses of helpers still online come right after the welcome.
        this.set({ status: 'open', attempt: 0, ended: null, helpers, statuses: {}, stats: {} });
        return;
      }
      case 'helper.online': {
        const { helper } = message.payload;
        this.set({ helpers: { ...this.state.helpers, [helper.deviceId]: helper } });
        return;
      }
      case 'helper.offline': {
        const { deviceId } = message.payload;
        this.clearThumbnails(deviceId);
        this.set({
          helpers: without(this.state.helpers, deviceId),
          statuses: without(this.state.statuses, deviceId),
          stats: without(this.state.stats, deviceId),
        });
        return;
      }
      case 'helper.status': {
        const status = message.payload;
        const live = status.state === 'live' || status.state === 'paused';
        this.set({
          statuses: { ...this.state.statuses, [status.deviceId]: status },
          ...(live ? {} : { stats: without(this.state.stats, status.deviceId) }),
        });
        return;
      }
      case 'helper.stats':
        this.set({ stats: { ...this.state.stats, [message.payload.deviceId]: message.payload } });
        return;
      case 'helper.sourceThumbnail': {
        const { deviceId, sourceId, mimeType, data } = message.payload;
        this.set({
          thumbnails: {
            ...this.state.thumbnails,
            [thumbnailKey(deviceId, sourceId)]: `data:${mimeType};base64,${data}`,
          },
        });
        return;
      }
      case 'notice':
        this.set({
          notice: { seq: (this.state.notice?.seq ?? 0) + 1, payload: message.payload },
        });
        return;
      default:
        // Errors without a pending request, and unknown types, are ignored (PROTOCOL 3).
        return;
    }
  }

  private onClose(socket: SocketLike, code: number): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearTimers();
    this.failPending({ code: 'helper_offline' });
    if (this.stopped) return;
    const ended: HubEnd | null =
      code === CLOSE.Unauthenticated
        ? 'unauthenticated'
        : code === CLOSE.Replaced
          ? 'replaced'
          : code === CLOSE.ProtocolUnsupported
            ? 'reload'
            : null;
    const offline = { helpers: {}, statuses: {}, stats: {}, thumbnails: {} };
    if (ended) {
      this.set({ status: 'ended', ended, ...offline });
      return;
    }
    const attempt = this.state.attempt;
    this.set({ status: 'reconnecting', attempt: attempt + 1, ...offline });
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.connect();
      },
      retryDelay(code, attempt, this.random),
    );
  }
}
