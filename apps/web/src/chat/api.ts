// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions, useQueries, useQuery } from '@tanstack/react-query';
import { meQuery } from '../api/auth.ts';
import { chatUnread } from '@openlive/client';
import { webApi } from '../api/client.ts';
import { isWaitError } from '../api/query-client.ts';

// Unread chat messages for the space's room list and the navigation (docs/PROTOCOL.md 7.6). The
// room socket keeps the open room's count live; these refresh on focus, every two minutes and
// when a mention arrives (MentionNotices). After a 429 or do_quota_exceeded the two-minute
// refresh stops; focus and mentions still refresh.

const REFRESH_MS = 120_000;

export const chatUnreadKey = (spaceId: string) => ['space', spaceId, 'chatUnread'] as const;

export const chatUnreadQuery = (spaceId: string) =>
  queryOptions({
    queryKey: chatUnreadKey(spaceId),
    queryFn: () => chatUnread(webApi, spaceId),
    refetchInterval: (query) => (isWaitError(query.state.error) ? false : REFRESH_MS),
    staleTime: 30_000,
  });

/** Unread messages per room of a space. */
export function useChatUnread(spaceId: string): Record<string, number> {
  return useQuery(chatUnreadQuery(spaceId)).data ?? {};
}

/** Unread messages in every space of the user, for the navigation. */
export function useTotalUnread(): number {
  const me = useQuery(meQuery);
  const spaces = me.data?.memberships.map((m) => m.spaceId) ?? [];
  const results = useQueries({ queries: spaces.map((spaceId) => chatUnreadQuery(spaceId)) });
  return results.reduce(
    (sum, r) => sum + Object.values(r.data ?? {}).reduce((a, b) => a + b, 0),
    0,
  );
}

export { unreadLabel } from '@openlive/client';

/** Rooms whose chat is open in this tab: their mentions show in the chat, not as a toast. */
const openChats = new Set<string>();

export function chatOpened(roomId: string): () => void {
  openChats.add(roomId);
  return () => openChats.delete(roomId);
}

export const isChatOpen = (roomId: string): boolean => openChats.has(roomId);
