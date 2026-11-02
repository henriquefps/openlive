// SPDX-License-Identifier: AGPL-3.0-only
import type { RoomPresence } from '@openlive/protocol';
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { TAB_ID } from '../room/connection.ts';
import { SpacePresenceConnection, spaceSocketUrl } from './connection.ts';

// The room presence of the space shown in the sidebar (PROTOCOL.md 7.8). A socket is open only
// while a space's rooms are on screen; switching spaces closes the old one.

/** Tests provide their own connection factory. */
export const SpacePresenceContext = createContext<
  ((spaceId: string) => SpacePresenceConnection) | null
>(null);

/** Who is in voice and who streams in each room of `spaceId`, by room id (quiet rooms absent). */
export function useSpacePresence(spaceId: string): Record<string, RoomPresence> {
  const factory = useContext(SpacePresenceContext);
  // Creating one opens nothing; the effect starts it while mounted and stops it after.
  const connection = useMemo(
    () =>
      factory
        ? factory(spaceId)
        : new SpacePresenceConnection({ url: spaceSocketUrl(spaceId), tabId: TAB_ID }),
    [factory, spaceId],
  );
  useEffect(() => {
    connection.start();
    const online = () => connection.reconnect();
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('online', online);
      connection.stop();
    };
  }, [connection]);
  return useSyncExternalStore(connection.subscribe, () => connection.getState().rooms);
}
