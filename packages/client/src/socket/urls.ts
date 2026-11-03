// SPDX-License-Identifier: AGPL-3.0-only
import { wsTicket } from '../api/app.ts';
import { ApiError, type ApiClient } from '../api/client.ts';
import { ABNORMAL_CLOSE, CLOSE, QUOTA_CLOSE, SocketDialError } from './session.ts';

// Where the sockets are (docs/PROTOCOL.md 4, 11.6). The web connects on its own origin with the
// session cookie; the app connects to its instance with a single-use ticket in the query, fetched
// with its app token before every connect and reconnect.

export const socketPaths = {
  hub: () => '/ws/hub',
  space: (spaceId: string) => `/ws/spaces/${encodeURIComponent(spaceId)}`,
  room: (roomId: string) => `/ws/rooms/${encodeURIComponent(roomId)}`,
};

/**
 * The socket URL for `path` on an instance: `https://host` → `wss://host/path`, `http:` → `ws:`.
 * `origin` may also be a page's `protocol//host`.
 */
export function socketUrl(origin: string, path: string): string {
  const match = /^(https?|wss?):\/\/([^/?#]+)/i.exec(origin);
  if (!match) throw new Error(`not an absolute http(s) or ws(s) URL: ${origin}`);
  const scheme = /^(https|wss)$/i.test(match[1] ?? '') ? 'wss' : 'ws';
  return `${scheme}://${match[2]}${path}`;
}

/** What a failed ticket request means for the socket. */
function dialError(error: unknown): SocketDialError {
  if (error instanceof ApiError) {
    // Signed out or the token revoked: the same as the socket's own 4001, no retry.
    if (error.status === 401) return new SocketDialError(CLOSE.Unauthenticated);
    if (error.status === 503 && error.body.code === 'do_quota_exceeded') {
      return new SocketDialError(QUOTA_CLOSE);
    }
  }
  // Offline, rate limited (429), a server error: reconnect with the usual backoff.
  return new SocketDialError(ABNORMAL_CLOSE);
}

/**
 * A SocketUrl for the app: before each (re)connect, POST /api/app/ws-ticket with the app token,
 * then `wss://instance/path?ticket=…`. `api.baseUrl` must be the instance URL.
 */
export function ticketSocketUrl(api: ApiClient, path: string): () => Promise<string> {
  return async () => {
    let ticket: string;
    try {
      ({ ticket } = await wsTicket(api));
    } catch (error) {
      throw dialError(error);
    }
    return `${socketUrl(api.baseUrl, path)}?ticket=${encodeURIComponent(ticket)}`;
  };
}
