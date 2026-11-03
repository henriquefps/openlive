// SPDX-License-Identifier: AGPL-3.0-only
import {
  RoomConnection as ClientRoomConnection,
  type RoomConnectionOptions,
  socketPaths,
  socketUrl,
} from '@openlive/client';
import { version as CLIENT_VERSION } from '../../package.json';

// The web's room socket: the shared connection (@openlive/client, room/connection.ts) with this
// page's origin, the session cookie (sent by the browser on the upgrade) and this app's version.

export {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  backoffDelay,
  CLOSE,
  type EndReason,
  INITIAL_STATE,
  INITIAL_VOICE,
  PING_FRAME,
  PING_INTERVAL_MS,
  PROTOCOL,
  QUOTA_CLOSE,
  QUOTA_RETRY_MS,
  retryDelay,
  type RoomState,
  type RoomStatus,
  type SocketLike,
  type WatchAccess,
  WELCOME_TIMEOUT_MS,
} from '@openlive/client';

export type ConnectionOptions = Omit<RoomConnectionOptions, 'clientVersion'>;

/** A random id for this browser tab, kept for the page's lifetime (hello.tabId). */
export const TAB_ID = `t_${crypto.randomUUID()}`;

/** The socket URL for a path on this page's origin (Vite proxies /ws in development). */
export function pageSocketUrl(path: string, location: Location = window.location): string {
  return socketUrl(`${location.protocol}//${location.host}`, path);
}

/** The socket URL for a room, on this page's origin. */
export function roomSocketUrl(roomId: string, location: Location = window.location): string {
  return pageSocketUrl(socketPaths.room(roomId), location);
}

export class RoomConnection extends ClientRoomConnection {
  constructor(options: ConnectionOptions) {
    super({ clientVersion: CLIENT_VERSION, ...options });
  }
}
