// SPDX-License-Identifier: AGPL-3.0-only
import {
  type HubConnection as HubConnectionType,
  HubConnection,
  HubNoticeWatcher,
  hubNoticeText,
  type NoticeEvent,
  type RoomConnection,
  roomNoticeText,
  RoomNoticeWatcher,
  socketPaths,
  type Translate,
} from '@openlive/client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState } from 'react-native';
import { socketOptions, useApi } from '../hooks.ts';
import { keys } from '../lib/cache.ts';
import { useScope } from '../queries.ts';
import { useInstances } from '../state.tsx';
import { voiceSessions } from '../voice/host.ts';
import { useVoiceSessionsState } from '../voice/hooks.ts';
import { isChatOpen, notify, type RoomTarget } from './notify.ts';

// Where the notices come from in the app (the web's notices/AppNotices.tsx): a watcher on every
// room socket the app has open for voice, one on the room being shown (when it has no voice
// socket), and a hub socket per signed-in server for the mentions and your own helpers. Each
// compares one state with the next, so opening a room or reconnecting is never a notice.

/** The shared texts take i18next's `t` without its key typing. */
const translator = (t: unknown): Translate => t as Translate;

/** The cues and toasts of the app's sockets; mount once, near the root. */
export function Notices() {
  const { instances } = useInstances();
  return (
    <>
      <VoiceRoomNotices />
      {instances
        .filter((i) => i.user)
        .map((i) => (
          <ServerHub key={`${i.origin}/${i.user?.userId}`} origin={i.origin} />
        ))}
    </>
  );
}

/** A watcher per room the voice has open (the one you are in, and the ones being shown). */
function VoiceRoomNotices() {
  useVoiceSessionsState();
  return voiceSessions.openSessions().map((session) => (
    <RoomWatch
      key={session.roomId}
      connection={session.parts.connection}
      target={
        session.link
          ? {
              origin: session.link.origin,
              spaceId: session.link.spaceId,
              roomId: session.roomId,
              roomName: session.name || session.link.roomName,
            }
          : undefined
      }
    />
  ));
}

function RoomWatch({
  connection,
  target,
}: {
  connection: RoomConnection;
  target: RoomTarget | undefined;
}) {
  const { t } = useTranslation();
  useRoomNotices(connection, true, target, t);
  return null;
}

/**
 * Notices of one room socket. The room screen turns it on for a room with no voice socket (the
 * voice session's watcher already covers the others).
 */
export function useRoomNotices(
  connection: RoomConnection | null,
  enabled: boolean,
  target: RoomTarget | undefined,
  t: unknown,
): void {
  const roomId = target?.roomId;
  const origin = target?.origin;
  const spaceId = target?.spaceId;
  const roomName = target?.roomName;
  const stable = useMemo(
    () =>
      roomId && origin && spaceId
        ? { origin, spaceId, roomId, roomName: roomName ?? '' }
        : undefined,
    [roomId, origin, spaceId, roomName],
  );
  useEffect(() => {
    if (!connection || !enabled) return;
    const watcher = new RoomNoticeWatcher();
    watcher.update(connection.getState());
    return connection.subscribe(() => {
      const room = connection.getState();
      for (const notice of watcher.update(room)) {
        notify(notice.event, roomNoticeText(notice, room, translator(t)), {
          ...(stable ? { target: stable } : {}),
          key: `${stable?.roomId ?? ''}/${notice.userId ?? ''}/${notice.streamId ?? ''}`,
        });
      }
    });
  }, [connection, enabled, stable, t]);
}

/** One server's hub socket: your mentions (anywhere) and your helpers' alerts. */
function ServerHub({ origin }: { origin: string }) {
  const { t } = useTranslation();
  const api = useApi(origin);
  const scope = useScope(origin);
  const queryClient = useQueryClient();
  const hub = useMemo<HubConnectionType | null>(
    () => (api ? new HubConnection(socketOptions(api, socketPaths.hub())) : null),
    [api],
  );
  useEffect(() => {
    if (!hub) return;
    hub.start();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && hub.getState().status === 'reconnecting') hub.reconnect();
    });
    return () => {
      subscription.remove();
      hub.stop();
    };
  }, [hub]);
  useEffect(() => {
    if (!hub) return;
    const watcher = new HubNoticeWatcher();
    watcher.update(hub.getState());
    let seen = 0;
    return hub.subscribe(() => {
      const state = hub.getState();
      for (const notice of watcher.update(state)) {
        notify(notice.event, hubNoticeText(notice.event, translator(t)), {
          key: `${origin}/${notice.streamId ?? ''}`,
        });
      }
      const mention = state.notice;
      if (!mention || mention.seq <= seen) return;
      seen = mention.seq;
      const { event, roomId } = mention.payload;
      if (event !== 'chat_mention' || roomId === undefined) return;
      if (scope) {
        // The unread counts of every space of this server read again.
        const [root, o, user] = keys(scope).spaces();
        void queryClient.invalidateQueries({
          predicate: (q) =>
            q.queryKey[0] === root &&
            q.queryKey[1] === o &&
            q.queryKey[2] === user &&
            q.queryKey[3] === 'unread',
        });
      }
      if (!isChatOpen(roomId)) {
        notify('mention', hubNoticeText('mention' satisfies NoticeEvent, translator(t)), {
          key: `${origin}/${roomId}/${mention.seq}`,
        });
      }
    });
  }, [hub, t, origin, scope, queryClient]);
  return null;
}
