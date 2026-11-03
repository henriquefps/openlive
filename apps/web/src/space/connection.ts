// SPDX-License-Identifier: AGPL-3.0-only
import {
  SpacePresenceConnection as ClientSpacePresenceConnection,
  type SpacePresenceOptions as ClientSpacePresenceOptions,
  socketPaths,
} from '@openlive/client';
import { version as CLIENT_VERSION } from '../../package.json';
import { pageSocketUrl } from '../room/connection.ts';

// The web's space presence socket: the shared connection (@openlive/client, space/connection.ts)
// on this page's origin, with this app's version.

export {
  INITIAL_SPACE_PRESENCE,
  type SpacePresenceState,
  type SpacePresenceStatus,
} from '@openlive/client';

export type SpacePresenceOptions = Omit<ClientSpacePresenceOptions, 'clientVersion'>;

/** The space presence socket URL on this page's origin (Vite proxies /ws in development). */
export function spaceSocketUrl(spaceId: string, location: Location = window.location): string {
  return pageSocketUrl(socketPaths.space(spaceId), location);
}

export class SpacePresenceConnection extends ClientSpacePresenceConnection {
  constructor(options: SpacePresenceOptions) {
    super({ clientVersion: CLIENT_VERSION, ...options });
  }
}
