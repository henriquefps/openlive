// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiClient } from './client.ts';

// What happened while the app was away (docs/PROTOCOL.md 11.7).

/** A stream that started in a room of a space. */
export interface RecentStream {
  streamId: string;
  roomId: string;
  userId: string;
  userName: string;
  /** Epoch ms. */
  startedAt: number;
}

/**
 * The streams that started in the space after `since` (epoch ms), newest first, in the rooms the
 * caller may see. An older server has no such route: the answer is empty.
 */
export async function recentStreams(
  api: ApiClient,
  spaceId: string,
  since: number,
): Promise<RecentStream[]> {
  try {
    const body = await api.get<{ streams: RecentStream[] }>(
      `/api/spaces/${encodeURIComponent(spaceId)}/streams/recent?since=${Math.max(0, Math.floor(since))}`,
    );
    return body.streams;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return [];
    throw error;
  }
}
