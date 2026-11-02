// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { TAB_ID } from '../room/connection.ts';
import { HubConnection, type HubState, hubSocketUrl } from './connection.ts';

// One hub socket per tab, shared by every screen that needs it (the room's Go live flow,
// Settings > Devices). It opens with the first user and closes shortly after the last one
// leaves, so moving between pages does not reconnect.

/** Tests (and the dev pages) provide their own connection. */
export const HubContext = createContext<HubConnection | null>(null);

const LINGER_MS = 5_000;
let shared: HubConnection | null = null;
let users = 0;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

function acquire(): HubConnection {
  if (stopTimer !== null) clearTimeout(stopTimer);
  stopTimer = null;
  shared ??= new HubConnection({ url: hubSocketUrl(), tabId: TAB_ID });
  users += 1;
  shared.start();
  return shared;
}

function release(): void {
  users -= 1;
  if (users > 0) return;
  stopTimer = setTimeout(() => {
    stopTimer = null;
    if (users === 0) shared?.stop();
  }, LINGER_MS);
}

function sharedConnection(): HubConnection {
  shared ??= new HubConnection({ url: hubSocketUrl(), tabId: TAB_ID });
  return shared;
}

/** The user hub while mounted: helpers online, their status and stats, and commands. */
export function useHub(): { state: HubState; hub: HubConnection } {
  const provided = useContext(HubContext);
  const hub = provided ?? sharedConnection();
  useEffect(() => {
    if (provided) return;
    acquire();
    const online = () => {
      if (sharedConnection().getState().status === 'reconnecting') sharedConnection().reconnect();
    };
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('online', online);
      release();
    };
  }, [provided]);
  const state = useSyncExternalStore(hub.subscribe, hub.getState);
  return { state, hub };
}
