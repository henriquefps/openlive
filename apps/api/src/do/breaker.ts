// SPDX-License-Identifier: AGPL-3.0-only
import { type MetricScope, metricsDataset, writeBreakerTrip } from '../metrics/points';
import { TokenBuckets } from '../room/pings';

// A circuit breaker inside every Durable Object. Both outages that took the
// instance down for a day were one object going wild: an alarm re-arming itself in the past (880
// alarms a minute for two hours) and, before it, rows written per event. Cloudflare's account
// analytics lag minutes behind, so this layer counts, in memory and in real time, what each object
// is asked to do, and stops it when that is far beyond any real use. It costs nothing on the hot
// path: counters in memory, no storage read or write. Only a trip writes (one key, once).

/** What a Durable Object is invoked for. */
export type BreakerKind = 'alarm' | 'request' | 'message';
/** What tripped: one kind, the sum of all kinds, or one socket's own message rate. */
export type BreakerCause = BreakerKind | 'total' | 'socket';
export type BreakerWindow = 'minute' | 'hour' | 'second';
/** The classes this guards, as the metric and the log name them. */
export type BreakerObject = 'RoomDO' | 'SpaceDO' | 'UserHubDO';

/**
 * Per object, most invocations allowed in a fixed one-minute and one-hour window, by kind
 * (`request` is a fetch or an RPC call). Far above any real use, derived from the measured
 * scenarios: in a normal group's hour the room peaks at 47 invocations a minute, 18 alarms and
 * 622 messages an hour (test/free-tier.test.ts). `message` and `total` are a base:
 * BREAKER_PER_SOCKET is added for every socket open in the window.
 */
export const BREAKER_LIMITS = {
  alarm: { minute: 120, hour: 1_200 },
  request: { minute: 1_800, hour: 18_000 },
  message: { minute: 3_000, hour: 30_000 },
  total: { minute: 3_600, hour: 36_000 },
} as const satisfies Record<BreakerKind | 'total', Record<'minute' | 'hour', number>>;

/**
 * One socket's own messages, as a token bucket (the idea of PING_RATE_PER_S in do/room.ts): a web
 * tab or helper sends at most about 5 a second (pointer pings are held to 4 by the client), so a
 * socket past this rate and burst is a client in a loop. It is closed; the object is not tripped.
 */
export const SOCKET_MESSAGE_RATE_PER_S = 10;
export const SOCKET_MESSAGE_BURST = 120;

/**
 * Added to the object's `message` and `total` limits for each socket open in the window (the most
 * seen in it). A room has no member ceiling and every person may send pointer pings at
 * PING_RATE_PER_S (4 a second, 240 a minute) besides renewals, voice, chat and read receipts
 * (about 4.6 a second in all in a busy room), so the object-level message limit grows with the
 * room: 8 a second per socket over a minute, 7 over the hour, above that use and below the
 * per-socket bucket's 10. Each socket is bounded by its bucket; this bound catches many sockets
 * each in a slower loop (a client bug in every tab). Incoming WebSocket messages are also the
 * cheapest kind (billed 20:1).
 */
export const BREAKER_PER_SOCKET = { minute: 480, hour: 25_200 } as const;

/** How long a tripped object refuses everything. The next event after it resumes normally. */
export const BREAKER_COOLDOWN_MS = 10 * 60_000;

/**
 * The close code of a socket the breaker closes: standard 1013 "try again later", the one a
 * refused upgrade already gets when the instance is out of Durable Objects quota (PROTOCOL.md
 * 1.15), so clients wait 15 minutes before they try again instead of reconnecting in a loop.
 */
export const BREAKER_CLOSE_CODE = 1013;
export const BREAKER_CLOSE_REASON = 'circuit_breaker';

/** The message of the error a guarded RPC method throws while the breaker is open. */
export const BREAKER_OPEN_ERROR = 'Durable Object circuit breaker open';

/** An error (from a guarded RPC, through the RPC boundary) because the breaker is open. */
export function isBreakerOpenError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(BREAKER_OPEN_ERROR);
}

/** Where a trip is kept, so an eviction or hibernation during the cool-down does not end it. */
const OPEN_UNTIL_KEY = 'breaker_open_until';

type Counts = Record<BreakerKind, number>;
const zero = (): Counts => ({ alarm: 0, request: 0, message: 0 });
const sum = (c: Counts) => c.alarm + c.request + c.message;

interface Window {
  start: number;
  counts: Counts;
  /** The most sockets open during the window, for the message and total limits. */
  sockets: number;
}

export interface BreakerOptions {
  object: BreakerObject;
  /** The metric's scope; called only on a trip. */
  scope?: () => MetricScope;
  /** The id written in the metric (never a user id); the log always names the object id. */
  metricId?: () => string;
  /** Open sockets now; the object's hibernatable sockets by default. */
  sockets?: () => number;
}

/** Every object's breaker, for the guarded RPC methods (guardRpc). */
const breakers = new WeakMap<object, CircuitBreaker>();

export class CircuitBreaker {
  private readonly minute: Window = { start: 0, counts: zero(), sockets: 0 };
  private readonly hour: Window = { start: 0, counts: zero(), sockets: 0 };
  private readonly sockets = new TokenBuckets(SOCKET_MESSAGE_RATE_PER_S, SOCKET_MESSAGE_BURST);
  /** Until when the breaker is open; undefined until read from storage (once per instance). */
  private openUntil: number | undefined;
  /** Trips since this instance started (tests and the log). */
  trips = 0;

  constructor(
    owner: object,
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly options: BreakerOptions,
  ) {
    breakers.set(owner, this);
  }

  /** The breaker is open: the object serves nothing until the cool-down ends. */
  isOpen(now = Date.now()): boolean {
    this.openUntil ??= this.ctx.storage.kv.get<number>(OPEN_UNTIL_KEY) ?? 0;
    return now < this.openUntil;
  }

  /**
   * Counts one invocation of `kind`. False when the object must not serve it: the breaker is open,
   * or this invocation tripped it. While open nothing is counted.
   */
  enter(kind: BreakerKind, now = Date.now()): boolean {
    if (this.isOpen(now)) return false;
    for (const [w, length] of [
      [this.minute, 60_000],
      [this.hour, 3_600_000],
    ] as const) {
      if (now - w.start >= length || now < w.start) {
        w.start = now;
        w.counts = zero();
        // Once a window: the sockets already open count for it.
        w.sockets = this.openSockets();
      }
      w.counts[kind] += 1;
    }
    for (const window of ['minute', 'hour'] as const) {
      const counts = this[window].counts;
      if (counts[kind] > this.limit(kind, window)) {
        this.trip(kind, window, counts, now);
        return false;
      }
      if (sum(counts) > this.limit('total', window)) {
        this.trip('total', window, counts, now);
        return false;
      }
    }
    return true;
  }

  /** A socket was accepted: it counts for the message and total limits of both windows. */
  connected(): void {
    const open = this.openSockets();
    this.minute.sockets = Math.max(this.minute.sockets, open);
    this.hour.sockets = Math.max(this.hour.sockets, open);
  }

  /** The limit of `kind` in `window`: message and total grow with the window's sockets. */
  limit(kind: BreakerKind | 'total', window: 'minute' | 'hour'): number {
    const base = BREAKER_LIMITS[kind][window];
    if (kind !== 'message' && kind !== 'total') return base;
    return base + BREAKER_PER_SOCKET[window] * this[window].sockets;
  }

  private openSockets(): number {
    try {
      return this.options.sockets?.() ?? this.ctx.getWebSockets().length;
    } catch {
      return 0;
    }
  }

  /**
   * One message on the socket `key` (its connection id). False when the socket is past its own
   * rate: the caller closes it with BREAKER_CLOSE_CODE. Logged and measured once, since the socket
   * is closed.
   */
  socketMessage(key: string, now = Date.now()): boolean {
    if (this.sockets.take(key, now) === 0) return true;
    // An empty bucket: at least the burst arrived faster than the rate refills it.
    this.report('socket', 'second', { alarm: 0, request: 0, message: SOCKET_MESSAGE_BURST }, now);
    return false;
  }

  /** Opens the breaker: stops the alarm, keeps the trip in storage, logs and measures it once. */
  private trip(cause: BreakerCause, window: BreakerWindow, counts: Counts, now: number): void {
    this.openUntil = now + BREAKER_COOLDOWN_MS;
    this.trips += 1;
    try {
      this.ctx.storage.kv.put(OPEN_UNTIL_KEY, this.openUntil);
    } catch (error) {
      // The trip still holds in memory.
      console.warn('circuit breaker: could not store the trip', error);
    }
    // Not re-armed while open: every handler returns before it would set the alarm.
    this.ctx.storage.deleteAlarm().catch((error: unknown) => {
      console.warn('circuit breaker: could not delete the alarm', error);
    });
    this.report(cause, window, { ...counts }, now);
    this.minute.counts = zero();
    this.hour.counts = zero();
  }

  private report(cause: BreakerCause, window: BreakerWindow, counts: Counts, now: number): void {
    const scope = this.options.scope?.() ?? { spaceId: null };
    const object = this.options.object;
    console.error('durable object circuit breaker tripped', {
      object,
      id: this.ctx.id.toString(),
      cause,
      window,
      ...counts,
      ...(cause === 'socket'
        ? {}
        : { openUntil: new Date(now + BREAKER_COOLDOWN_MS).toISOString() }),
    });
    writeBreakerTrip(metricsDataset(this.env), scope, {
      object,
      objectId: this.options.metricId?.() ?? '',
      cause,
      window,
      ...counts,
      cooldownS: cause === 'socket' ? 0 : BREAKER_COOLDOWN_MS / 1000,
    });
  }
}

/** The breaker of a Durable Object instance (tests). */
export function breakerOf(owner: object): CircuitBreaker | undefined {
  return breakers.get(owner);
}

/**
 * Wraps the RPC methods `names` of a Durable Object class so each call counts as a `request`, and
 * throws BREAKER_OPEN_ERROR while the breaker is open. RPC calls have no common entry point, so
 * the class lists them: a new RPC method is added to its list.
 */
export function guardRpc<T extends object>(
  cls: { prototype: T },
  names: readonly (keyof T & string)[],
): void {
  const proto = cls.prototype as Record<string, unknown>;
  for (const name of names) {
    const original = proto[name];
    if (typeof original !== 'function') throw new TypeError(`not a method: ${name}`);
    proto[name] = function (this: object, ...args: unknown[]): unknown {
      const breaker = breakers.get(this);
      // Thrown, not a rejected promise: the RPC layer hands it to the caller either way.
      if (breaker && !breaker.enter('request')) throw new Error(BREAKER_OPEN_ERROR);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
}

/**
 * The answer to a WebSocket upgrade while the breaker is open: accepted and closed at once with
 * BREAKER_CLOSE_CODE, since a browser cannot read the status of a refused upgrade.
 */
export function refusedUpgrade(): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(BREAKER_CLOSE_CODE, BREAKER_CLOSE_REASON);
  return new Response(null, { status: 101, webSocket: client });
}
