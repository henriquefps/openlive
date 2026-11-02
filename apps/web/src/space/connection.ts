// SPDX-License-Identifier: AGPL-3.0-only
import type { HelloMessage, Message, RoomPresence } from '@openlive/protocol';
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

// The web side of the space's room presence (docs/PROTOCOL.md 7.8): who is in each room's voice
// and who streams there, for the sidebar. One socket per shown space; same handshake, keepalive
// and reconnect rules as the room socket (room/connection.ts). The server only sends; this side
// only says hello.

export type SpacePresenceStatus = 'connecting' | 'open' | 'reconnecting' | 'ended';

export interface SpacePresenceState {
  status: SpacePresenceStatus;
  attempt: number;
  /** The non-empty summaries the user may see, by room id. */
  rooms: Record<string, RoomPresence>;
}

export const INITIAL_SPACE_PRESENCE: SpacePresenceState = {
  status: 'connecting',
  attempt: 0,
  rooms: {},
};

export interface SpacePresenceOptions {
  url: string;
  tabId: string;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
}

const OPEN = 1;
/** Closes after which the socket stays down (PROTOCOL 5): not signed in, no access, old app. */
const FINAL = new Set<number>([
  CLOSE.Unauthenticated,
  CLOSE.Replaced,
  CLOSE.Forbidden,
  CLOSE.ProtocolUnsupported,
]);

/** The space presence socket URL on this page's origin (Vite proxies /ws in development). */
export function spaceSocketUrl(spaceId: string, location: Location = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws/spaces/${encodeURIComponent(spaceId)}`;
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

const quiet = (room: RoomPresence) => room.voice.length === 0 && room.live.length === 0;

export class SpacePresenceConnection {
  private state: SpacePresenceState = INITIAL_SPACE_PRESENCE;
  private readonly listeners = new Set<() => void>();
  private socket: SocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly random: () => number;

  constructor(private readonly options: SpacePresenceOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.random = options.random ?? Math.random;
  }

  getState = (): SpacePresenceState => this.state;

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
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close(1000);
    }
  }

  /** Connects again now, skipping the backoff wait (the browser came back online). */
  reconnect(): void {
    if (this.stopped || this.state.status !== 'reconnecting') return;
    this.clearTimers();
    if (this.socket) return;
    this.connect();
  }

  private set(patch: Partial<SpacePresenceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer);
    this.pingTimer = this.retryTimer = this.welcomeTimer = null;
  }

  private connect(): void {
    this.set({ status: this.state.attempt === 0 ? 'connecting' : 'reconnecting' });
    const socket = this.createSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      const hello: HelloMessage = {
        type: 'hello',
        id: '1',
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
    switch (message.type) {
      case 'space.presence': {
        // The welcome, or a fresh list after the user's access changed: it replaces everything.
        if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer);
        this.welcomeTimer = null;
        const rooms = Object.fromEntries(
          message.payload.rooms.filter((r) => !quiet(r)).map((r) => [r.roomId, r]),
        );
        this.set({ status: 'open', attempt: 0, rooms });
        return;
      }
      case 'space.presence.updated': {
        const { room } = message.payload;
        const rest = Object.fromEntries(
          Object.entries(this.state.rooms).filter(([id]) => id !== room.roomId),
        );
        this.set({ rooms: quiet(room) ? rest : { ...rest, [room.roomId]: room } });
        return;
      }
      default:
        // Errors (followed by a close) and unknown types are ignored (PROTOCOL 3).
        return;
    }
  }

  private onClose(socket: SocketLike, code: number): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearTimers();
    if (this.stopped) return;
    if (FINAL.has(code)) {
      this.set({ status: 'ended', rooms: {} });
      return;
    }
    // The last known presence stays on screen while reconnecting; the welcome replaces it.
    const attempt = this.state.attempt;
    this.set({ status: 'reconnecting', attempt: attempt + 1 });
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.connect();
      },
      retryDelay(code, attempt, this.random),
    );
  }
}
