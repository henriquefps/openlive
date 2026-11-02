// SPDX-License-Identifier: AGPL-3.0-only
import type { ConnectContext } from './types';

// The internal request the Worker sends to the RoomDO or the UserHubDO to open a socket.
//
// The Worker builds this request from scratch: none of the client's headers are copied, so a
// client cannot forge the identity header, and the DO is only reachable through its binding.
// A WebSocket upgrade has to go through fetch (RPC cannot return the socket), hence a header and
// not an RPC argument. The value is URI-encoded JSON because header values must be Latin-1 and
// display names are not.

export const CONNECT_PATH = '/internal/connect';
const CONNECT_HEADER = 'X-Openlive-Connect';

export function connectRequest<T = ConnectContext>(context: T): Request {
  return new Request(`https://do.internal${CONNECT_PATH}`, {
    headers: {
      Upgrade: 'websocket',
      [CONNECT_HEADER]: encodeURIComponent(JSON.stringify(context)),
    },
  });
}

export function decodeConnectContext<T = ConnectContext>(request: Request): T | null {
  const raw = request.headers.get(CONNECT_HEADER);
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw)) as T;
  } catch {
    return null;
  }
}
