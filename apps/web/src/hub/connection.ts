// SPDX-License-Identifier: AGPL-3.0-only
import {
  HubConnection as ClientHubConnection,
  type HubConnectionOptions as ClientHubConnectionOptions,
  socketPaths,
} from '@openlive/client';
import { version as CLIENT_VERSION } from '../../package.json';
import { pageSocketUrl } from '../room/connection.ts';

// The web's user hub socket: the shared connection (@openlive/client, hub/connection.ts) on this
// page's origin, with this app's version.

export {
  COMMAND_TIMEOUT_MS,
  type HubCommand,
  type HubEnd,
  HubError,
  type HubReply,
  type HubState,
  type HubStatus,
  INITIAL_HUB_STATE,
  thumbnailKey,
} from '@openlive/client';

export type HubConnectionOptions = Omit<ClientHubConnectionOptions, 'clientVersion'>;

/** The hub socket URL on this page's origin (Vite proxies /ws in development). */
export function hubSocketUrl(location: Location = window.location): string {
  return pageSocketUrl(socketPaths.hub(), location);
}

export class HubConnection extends ClientHubConnection {
  constructor(options: HubConnectionOptions) {
    super({ clientVersion: CLIENT_VERSION, ...options });
  }
}
