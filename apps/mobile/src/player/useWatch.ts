// SPDX-License-Identifier: AGPL-3.0-only
import {
  bearerToken,
  createApiClient,
  getMe,
  RoomConnection,
  socketPaths,
  ticketSocketUrl,
} from '@openlive/client';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { helloClientVersion } from '../lib/client-version.ts';
import { InstanceStore, type SavedInstance } from '../lib/storage.ts';
import { useInstances } from '../state.tsx';
import { CellularMonitor } from './cellular.ts';
import { WatchController, type WatchSnapshot } from './controller.ts';
import { createSession, createSource, type RnSession, type RnSource } from './rtc.ts';

// One watched stream: its own room socket (like a second tab of the web: the viewer slot belongs to
// the socket, so it is given back when the view closes or the socket drops), the room's SFU session
// and the WatchController that ties them. Everything is created and torn down in an effect, so
// React's strict mode (start, stop, start) is safe.

export interface Watch {
  controller: WatchController<RnSource>;
  connection: RoomConnection;
  session: RnSession;
  cellular: CellularMonitor;
  /** Brake 6 and the metrics need the server's settings (/api/me); this asks for them. */
  loadSettings: () => Promise<void>;
}

const store = new InstanceStore(SecureStore);
const clientVersion = helloClientVersion(Constants.expoConfig?.version);

/** The stream's room socket, SFU session and controller; they start with the component. */
export function useWatch(
  instance: SavedInstance,
  roomId: string,
  streamId: string,
  onIdleStop: () => void,
): Watch {
  const { expired } = useInstances();
  const { origin } = instance;
  const idleStop = useRef(onIdleStop);
  useEffect(() => {
    idleStop.current = onIdleStop;
  });

  // Creating these opens nothing; the effect below starts and stops them (strict-mode safe).
  const watch = useMemo<Watch>(() => {
    const api = createApiClient({
      baseUrl: origin,
      auth: bearerToken(() => store.getToken(origin)),
    });
    const connection = new RoomConnection({
      url: ticketSocketUrl(api, socketPaths.room(roomId)),
      tabId: Crypto.randomUUID(),
      clientVersion,
    });
    const session = createSession(api, roomId);
    const cellular = new CellularMonitor(Network);
    const controller = new WatchController<RnSource>({
      room: connection,
      streamId,
      cellular: () => cellular.cellular,
      onIdleStop: () => idleStop.current(),
      // The same windows the web posts (POST /api/metrics/viewer); a failed post is dropped.
      metrics: {
        roomId,
        send: (body) => void api.send('POST', '/api/metrics/viewer', body).catch(() => undefined),
      },
      createSource: (stream, slotId) => createSource(session, stream, slotId),
      isTrackMuted: (source) => source.stream.getVideoTracks()[0]?.muted ?? false,
    });
    // The server may turn the "Still watching?" brake off for everyone (viewerBrakes in /api/me).
    const loadSettings = async () => {
      const me = await getMe(api).catch(() => null);
      if (me?.viewerBrakes) controller.setIdleCheck(me.viewerBrakes.idleCheck);
    };
    return { controller, connection, session, cellular, loadSettings };
  }, [origin, roomId, streamId]);

  useEffect(() => {
    const { controller, connection, session, cellular, loadSettings } = watch;
    // The token is gone (expired, revoked): the socket closes as unauthenticated.
    const offRoom = connection.subscribe(() => {
      if (connection.getState().ended?.kind === 'unauthenticated') void expired(origin);
    });
    const foreground = (state: string) => {
      const active = state === 'active';
      controller.setForeground(active);
      if (active && connection.getState().status === 'reconnecting') connection.reconnect();
    };
    const appState = AppState.addEventListener('change', foreground);

    cellular.start();
    void loadSettings();
    connection.start();
    session.start();
    controller.start();
    foreground(AppState.currentState ?? 'active');

    return () => {
      appState.remove();
      offRoom();
      controller.close();
      cellular.stop();
      // The pulled tracks are closed before the session leaves (never unsubscribe after leave).
      void session.closeAfterUnpulls();
      connection.stop();
    };
  }, [watch, expired, origin]);

  return watch;
}

/** The controller's snapshot, re-rendering on every change. */
export function useWatchSnapshot(watch: Watch): WatchSnapshot<RnSource> {
  return useSyncExternalStore(watch.controller.subscribe, watch.controller.getSnapshot);
}
