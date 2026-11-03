// SPDX-License-Identifier: AGPL-3.0-only
import type { CloseCode, HelloMessage, Message, ProtocolVersion } from '@openlive/protocol';

// What the room, hub and space sockets have in common (docs/PROTOCOL.md 4, 5): hello → welcome
// with a timeout, ping keepalive, reconnect with backoff, and the URL to dial, which may need an
// await first (the app's single-use ticket, socket/urls.ts). Each socket's own messages and close
// rules live in its subclass (room/connection.ts, hub/connection.ts, space/connection.ts).
//
// Only types come from @openlive/protocol: a runtime import would bundle its validators (ajv)
// into the web app. The few constants needed here are copied, and the tests check them against
// the package. Incoming frames are trusted to follow the schema (the server validates what it
// sends), so they only get a shape check.

/** Same bytes as PING_FRAME in @openlive/protocol: the DO answers without waking up. */
export const PING_FRAME = '{"type":"ping","payload":{}}';
export const PROTOCOL: ProtocolVersion = { major: 1, minor: 21 };
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
/** The code a socket that never opened reports: the network, a refused upgrade, no ticket. */
export const ABNORMAL_CLOSE = 1006;

/** Full-jitter exponential backoff: between half and all of min(max, base · 2^attempt). */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/** How long to wait before reconnecting after a close with `code`. */
export function retryDelay(code: number, attempt: number, random: () => number = Math.random) {
  if (code === QUOTA_CLOSE) return Math.round(QUOTA_RETRY_MS * (1 + random() * 0.2));
  return backoffDelay(attempt, random);
}

// A handler type checked bivariantly, so the browser's and React Native's WebSocket (whose
// handlers take their own Event types) and test fakes all fit SocketLike.
type Handler<E> = { bivarianceHack(event: E): void }['bivarianceHack'];

/** The subset of a WebSocket the connections use, so tests and other platforms can pass theirs. */
export interface SocketLike {
  readonly readyState: number;
  onopen: Handler<unknown> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onclose: Handler<{ code: number }> | null;
  onerror: Handler<unknown> | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Where to connect: a URL, or a function that gives one (each connect and reconnect calls it
 * again, so a single-use ticket is fetched every time). A function that throws or rejects counts
 * as a socket that closed with ABNORMAL_CLOSE, or with a SocketDialError's code.
 */
export type SocketUrl = string | (() => string | Promise<string>);

/** A failure to get a socket URL that should be handled as a close with `code`. */
export class SocketDialError extends Error {
  constructor(
    readonly code: number,
    message = `socket dial failed (${code})`,
  ) {
    super(message);
    this.name = 'SocketDialError';
  }
}

export interface SocketSessionOptions {
  url: SocketUrl;
  /** A random id for this tab or app instance, kept for its lifetime (hello.tabId). */
  tabId: string;
  /** The client's own version (hello.clientVersion). */
  clientVersion: string;
  /** The platform's WebSocket by default. */
  createSocket?: (url: string) => SocketLike;
  /** Random source for the backoff jitter, [0, 1). */
  random?: () => number;
}

export const OPEN = 1;

/** The frame as a message when it has the envelope's shape; null otherwise (ignored). */
export function parseFrame(data: unknown): Message | null {
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

export function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

const platformSocket = (url: string): SocketLike => new WebSocket(url);

/**
 * One socket's life: dial, hello, welcome timeout, keepalive, and the reconnect timer. The state
 * is an immutable object that `subscribe` listeners (React's useSyncExternalStore) re-read.
 */
export abstract class SocketSession<S extends object> {
  protected state: S;
  private readonly listeners = new Set<() => void>();
  protected socket: SocketLike | null = null;
  protected stopped = false;
  protected nextId = 1;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Counts dials: a URL that arrives after a newer dial, or after stop(), is dropped. */
  private dial = 0;
  /** Waiting for an async URL; no socket yet. */
  private dialing = false;
  private readonly createSocket: (url: string) => SocketLike;
  protected readonly random: () => number;

  protected constructor(
    private readonly session: SocketSessionOptions,
    initial: S,
  ) {
    this.state = initial;
    this.createSocket = session.createSocket ?? platformSocket;
    this.random = session.random ?? Math.random;
  }

  getState = (): S => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A message from the server, already shape-checked. */
  protected abstract onMessage(message: Message): void;

  /**
   * The socket is gone (or never came: the URL failed) and the session was not stopped. Timers
   * are cleared; end for good or call `retryLater`.
   */
  protected abstract onLost(code: number): void;

  /** The hello's id: a fresh request id by default. */
  protected helloId(): string {
    return String(this.nextId++);
  }

  protected set(patch: Partial<S>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** A socket is open or being opened (its URL on the way). */
  protected get active(): boolean {
    return this.socket !== null || this.dialing;
  }

  /** A reconnect is scheduled. */
  protected get retrying(): boolean {
    return this.retryTimer !== null;
  }

  protected clearTimers(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer);
    this.pingTimer = this.retryTimer = this.welcomeTimer = null;
  }

  /** The welcome arrived: the socket is up. */
  protected welcomed(): void {
    if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer);
    this.welcomeTimer = null;
  }

  /** Stops for good: no reconnect, the socket closed with 1000. */
  protected shutdown(): void {
    this.stopped = true;
    this.dial++;
    this.dialing = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close(1000);
    }
  }

  protected retryLater(code: number, attempt: number): void {
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.connect();
      },
      retryDelay(code, attempt, this.random),
    );
  }

  /** Dials. Subclasses update their status first, then call this. */
  protected connect(): void {
    const dial = ++this.dial;
    let url: string | Promise<string>;
    try {
      const source = this.session.url;
      url = typeof source === 'string' ? source : source();
    } catch (error) {
      url = Promise.reject(error);
    }
    if (typeof url === 'string') {
      this.dialing = false;
      this.attach(url);
      return;
    }
    this.dialing = true;
    url.then(
      (resolved) => {
        if (dial !== this.dial) return;
        this.dialing = false;
        this.attach(resolved);
      },
      (error: unknown) => {
        if (dial !== this.dial) return;
        this.dialing = false;
        this.lost(error instanceof SocketDialError ? error.code : ABNORMAL_CLOSE);
      },
    );
  }

  private attach(url: string): void {
    const socket = this.createSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      const hello: HelloMessage = {
        type: 'hello',
        id: this.helloId(),
        payload: {
          protocol: PROTOCOL,
          client: 'web',
          clientVersion: this.session.clientVersion,
          tabId: this.session.tabId,
        },
      };
      socket.send(JSON.stringify(hello));
      this.welcomeTimer = setTimeout(() => {
        // The browser reports this close as 1000 or 1005; either way it is a reconnect.
        socket.close();
        this.onSocketClose(socket, ABNORMAL_CLOSE);
      }, WELCOME_TIMEOUT_MS);
      this.pingTimer = setInterval(() => {
        if (socket.readyState === OPEN) socket.send(PING_FRAME);
      }, PING_INTERVAL_MS);
    };
    socket.onmessage = (event) => {
      const message = parseFrame(event.data);
      if (message) this.onMessage(message);
    };
    socket.onclose = (event) => this.onSocketClose(socket, event.code);
  }

  private onSocketClose(socket: SocketLike, code: number): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.lost(code);
  }

  private lost(code: number): void {
    this.clearTimers();
    if (this.stopped) return;
    this.onLost(code);
  }
}
