// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ApiClient,
  ChatClient,
  INITIAL_CHAT,
  INITIAL_SPACE_PRESENCE,
  INITIAL_STATE,
  RoomConnection,
  type SocketSessionOptions,
  socketPaths,
  SpacePresenceConnection,
  ticketSocketUrl,
} from '@openlive/client';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { helloClientVersion } from './lib/client-version.ts';
import { AppState } from 'react-native';
import {
  chatMayPersist,
  type ChatSnapshot,
  keys,
  type PresenceSnapshot,
  type RoomSnapshot,
} from './lib/cache.ts';
import {
  chatSnapshot,
  chatView,
  presenceSnapshot,
  presenceView,
  roomSnapshot,
  roomView,
} from './lib/snapshots.ts';
import { useScope } from './queries.ts';
import { useInstances } from './state.tsx';

// The pieces the screens share: a client for an instance and the space and room sockets with
// their state, which start from the last snapshot in the cache (queries.ts has the REST reads). Sockets reconnect on their own (backoff); coming back
// to the app from the background asks them to try now.

/** The client for `origin` with its token; null while it loads or when signed out. */
export function useApi(origin: string): ApiClient | null {
  const { client, instances } = useInstances();
  const signedIn = Boolean(instances.find((i) => i.origin === origin)?.user);
  const [api, setApi] = useState<ApiClient | null>(null);
  useEffect(() => {
    let live = true;
    void client(origin).then((next) => {
      if (live) setApi(next);
    });
    return () => {
      live = false;
    };
  }, [client, origin, signedIn]);
  return api;
}

/** The `Authorization` header for loading an image from the instance (null until it is known). */
export function useAuthHeaders(api: ApiClient | null): Record<string, string> | null {
  const [headers, setHeaders] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let live = true;
    const auth = api?.auth;
    if (auth?.kind === 'bearer') {
      void Promise.resolve(auth.token()).then((token) => {
        if (live) setHeaders(token ? { Authorization: `Bearer ${token}` } : null);
      });
    }
    return () => {
      live = false;
    };
  }, [api]);
  return headers;
}

const noSubscribe = () => () => undefined;

const clientVersion = helloClientVersion(Constants.expoConfig?.version);

/** hello.tabId: new for every connection, so two sockets of this app never replace each other. */
export function socketOptions(api: ApiClient, path: string): SocketSessionOptions {
  return {
    url: ticketSocketUrl(api, path),
    tabId: Crypto.randomUUID(),
    clientVersion,
  };
}

/** Whether the app is in the foreground; a socket that gave up waiting tries again on return. */
function useOnForeground(callback: () => void): void {
  const ref = useRef(callback);
  useEffect(() => {
    ref.current = callback;
  });
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') ref.current();
    });
    return () => subscription.remove();
  }, []);
}

/**
 * A socket-driven entry of the cache: `seed` is what the screen starts from, `save` replaces it
 * with the live snapshot. The entry is set by the app, never fetched.
 */
function useSnapshot<T>(key: readonly unknown[] | null, origin: string) {
  const queryClient = useQueryClient();
  const seed = useQuery<T>({
    queryKey: key ?? ['ol', origin, '-', 'none'],
    queryFn: skipToken,
    staleTime: Infinity,
  }).data;
  const save = (snapshot: T | null) => {
    if (key && snapshot !== null) queryClient.setQueryData(key, snapshot);
  };
  return { seed: key ? seed : undefined, save };
}

/**
 * Who is in voice and who streams in each room of a space (the space socket). Until the socket's
 * snapshot arrives the last one stands in (`stale`); its events keep the cache entry current.
 */
export function useSpacePresence(api: ApiClient | null, origin: string, spaceId: string) {
  const scope = useScope(origin);
  const connection = useMemo(
    () =>
      api ? new SpacePresenceConnection(socketOptions(api, socketPaths.space(spaceId))) : null,
    [api, spaceId],
  );
  useEffect(() => {
    connection?.start();
    return () => connection?.stop();
  }, [connection]);
  useOnForeground(() => connection?.reconnect());
  const live = useSyncExternalStore(
    connection?.subscribe ?? noSubscribe,
    connection?.getState ?? (() => INITIAL_SPACE_PRESENCE),
  );
  const { seed, save } = useSnapshot<PresenceSnapshot>(
    scope ? keys(scope).presence(spaceId) : null,
    origin,
  );
  useEffect(() => {
    save(presenceSnapshot(live, Date.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, scope?.userId]);
  const view = presenceView(live, seed);
  return { ...live, rooms: view.rooms, stale: view.stale };
}

/**
 * A room's socket and its chat. The chat listens from before the socket opens (the welcome). The
 * room and the chat show the last snapshot of the cache until this connection's own arrives
 * (`stale`), and write theirs back as it changes.
 */
export function useRoom(api: ApiClient | null, origin: string, roomId: string, session = 0) {
  const scope = useScope(origin);
  const queryClient = useQueryClient();
  // `session` is bumped to start over with a fresh socket (pull to refresh).
  const connection = useMemo(
    () => (api ? new RoomConnection(socketOptions(api, socketPaths.room(roomId))) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, roomId, session],
  );
  const chat = useMemo(
    () =>
      connection
        ? new ChatClient({
            socket: {
              listen: connection.listen,
              request: (type, payload) => connection.sendRequest(type, payload),
            },
            // Hermes has no crypto.randomUUID everywhere.
            newClientId: () => Crypto.randomUUID().slice(0, 12),
          })
        : null,
    [connection],
  );
  useEffect(() => {
    if (!connection || !chat) return;
    const stopChat = chat.start();
    connection.start();
    return () => {
      stopChat();
      connection.stop();
    };
  }, [connection, chat]);
  useOnForeground(() => {
    if (connection?.getState().status === 'reconnecting') connection.reconnect();
  });
  const live = useSyncExternalStore(
    connection?.subscribe ?? noSubscribe,
    connection?.getState ?? (() => INITIAL_STATE),
  );
  const liveChat = useSyncExternalStore(
    chat?.subscribe ?? noSubscribe,
    chat?.getState ?? (() => INITIAL_CHAT),
  );

  const roomCache = useSnapshot<RoomSnapshot>(scope ? keys(scope).room(roomId) : null, origin);
  const chatKey = scope ? keys(scope).chat(roomId) : null;
  const chatCache = useSnapshot<ChatSnapshot>(chatKey, origin);
  useEffect(() => {
    roomCache.save(roomSnapshot(live, Date.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, scope?.userId]);
  useEffect(() => {
    chatCache.save(chatSnapshot(liveChat, live, Date.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveChat, live.settings, live.room, scope?.userId]);
  // A room that keeps no messages keeps none here either once the screen closes.
  const keepRef = useRef(true);
  useEffect(() => {
    const snapshot = chatKey ? queryClient.getQueryData<ChatSnapshot>(chatKey) : undefined;
    keepRef.current = snapshot === undefined || chatMayPersist(snapshot);
  });
  useEffect(
    () => () => {
      if (chatKey && !keepRef.current) queryClient.removeQueries({ queryKey: chatKey });
    },
    [chatKey, queryClient],
  );

  const roomShown = roomView(live, roomCache.seed);
  const chatShown = chatView(liveChat, live.you !== null, chatCache.seed);
  return {
    connection,
    chat,
    room: roomShown.state,
    chatState: chatShown.state,
    /** The room is the saved one while the socket's welcome is on its way. */
    roomStale: roomShown.stale,
    chatStale: chatShown.stale,
  };
}
