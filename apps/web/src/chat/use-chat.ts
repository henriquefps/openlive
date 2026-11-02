// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { chatOpened } from './api.ts';
import { ChatClient, type ChatClientOptions, type ChatSocket } from './client.ts';

/**
 * The room's text chat while mounted. The client listens from before the socket opens, so it sees
 * the welcome; whether the room has text comes from there (and from room.updated).
 */
export function useChat(
  roomId: string,
  socket: ChatSocket,
  onMention?: ChatClientOptions['onMention'],
) {
  const client = useMemo(
    () => new ChatClient({ socket, ...(onMention ? { onMention } : {}) }),
    // onMention is read when a mention arrives; a new one need not rebuild the client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [socket],
  );
  useEffect(() => client.start(), [client]);
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const on = state.status !== 'off';
  useEffect(() => (on ? chatOpened(roomId) : undefined), [on, roomId]);
  return { client, state };
}
