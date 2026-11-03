// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiClient } from './client.ts';

// The chat's REST side (docs/PROTOCOL.md 7.6); the messages themselves go over the room socket
// (chat-client.ts).

/** Unread chat messages per room of a space (the room caps each count at 99+). */
export const chatUnread = async (api: ApiClient, spaceId: string) =>
  (
    await api.get<{ rooms: Record<string, number> }>(
      `/api/spaces/${encodeURIComponent(spaceId)}/chat/unread`,
    )
  ).rooms;

/** "99+" above 99, as the room caps its counts. */
export const unreadLabel = (count: number): string => (count > 99 ? '99+' : String(count));
