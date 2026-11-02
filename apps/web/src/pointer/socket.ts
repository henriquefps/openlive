// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorPayload, Message, PointerStyle } from '@openlive/protocol';

// The visual pointer pings on the room socket (docs/PROTOCOL.md 7.9): the viewer's pointer.ping
// and the streamer's stream.setPings. A ping has no reply on success; an error comes back with
// the request's id, and the caller hears it through `onRejected`.
//
// The room allows 4 pings per second per person with a burst of 8. The same bucket runs here,
// so a fast clicker is told at once instead of after a round trip, and after a rate_limited the
// socket stays quiet until the room's retryAfterMs.

export const PING_RATE_PER_S = 4;
export const PING_BURST = 8;
/** Pending request ids kept; older ones are forgotten (their errors are then ignored). */
const MAX_PENDING = 64;

export type PointerRejection =
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'setPings'; error: ErrorPayload }
  | { kind: 'ping'; error: ErrorPayload };

export interface PointerSocket {
  /** Sends a ping; false when it was held back by the rate limit (nothing was sent). */
  ping: (streamId: string, x: number, y: number, style: PointerStyle) => boolean;
  /** The streamer allows or forbids pings on their own stream. */
  setPings: (streamId: string, enabled: boolean) => void;
  onRejected: (listener: (rejection: PointerRejection) => void) => () => void;
}

/** What the pointer needs of the room socket (room/connection.ts). */
export interface PointerTransport {
  listen: (listener: (message: Message) => void) => () => void;
  sendRequest: (type: string, payload: object) => string | null;
}

export function pointerSocket(
  transport: PointerTransport,
  now: () => number = () => Date.now(),
): PointerSocket {
  const pending = new Map<string, 'ping' | 'setPings'>();
  const listeners = new Set<(rejection: PointerRejection) => void>();
  let tokens = PING_BURST;
  let at = now();
  let quietUntil = 0;

  const emit = (rejection: PointerRejection) => {
    for (const listener of listeners) listener(rejection);
  };
  const track = (id: string | null, kind: 'ping' | 'setPings') => {
    if (id === null) return;
    pending.set(id, kind);
    if (pending.size > MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) pending.delete(oldest);
    }
  };

  transport.listen((message) => {
    if (message.type !== 'error' || message.id === undefined) return;
    const kind = pending.get(message.id);
    if (!kind) return;
    pending.delete(message.id);
    const error = message.payload;
    if (kind === 'ping' && error.code === 'rate_limited') {
      const retryAfterMs = error.retryAfterMs ?? 1000;
      quietUntil = Math.max(quietUntil, now() + retryAfterMs);
      emit({ kind: 'rate_limited', retryAfterMs });
    } else emit({ kind, error });
  });

  return {
    ping(streamId, x, y, style) {
      const t = now();
      tokens = Math.min(PING_BURST, tokens + ((t - at) / 1000) * PING_RATE_PER_S);
      at = t;
      if (t < quietUntil || tokens < 1) {
        const wait = Math.max(quietUntil - t, ((1 - tokens) / PING_RATE_PER_S) * 1000);
        emit({ kind: 'rate_limited', retryAfterMs: Math.max(1, Math.ceil(wait)) });
        return false;
      }
      const id = transport.sendRequest('pointer.ping', { streamId, x, y, style });
      if (id === null) return false;
      tokens -= 1;
      track(id, 'ping');
      return true;
    },
    setPings(streamId, enabled) {
      track(transport.sendRequest('stream.setPings', { streamId, enabled }), 'setPings');
    },
    onRejected(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
