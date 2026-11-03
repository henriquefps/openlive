// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatActivity, RecentStream } from '@openlive/client';
import { type ServerSummary, serverSummary, type SpaceActivity } from './model.ts';

// Reads what a server has to say about the time away: for each space of the person, its rooms
// (for the names), the unread and mention counts and the streams that started since. Three small
// calls per space, in parallel; a space or call that fails is left out (the summary is a courtesy,
// never an error screen).

export interface SummaryApi {
  spaces(): Promise<readonly { id: string }[]>;
  rooms(spaceId: string): Promise<readonly { id: string; name: string }[]>;
  chat(spaceId: string): Promise<ChatActivity>;
  streams(spaceId: string, since: number): Promise<readonly RecentStream[]>;
}

/** Spaces read per server (a person is rarely in more). */
export const MAX_SPACES = 8;

export async function loadServerSummary(
  origin: string,
  serverName: string,
  api: SummaryApi,
  since: number,
): Promise<ServerSummary> {
  const spaces = await api
    .spaces()
    .then((list) => list.slice(0, MAX_SPACES))
    .catch((): readonly { id: string }[] => []);
  const results = await Promise.allSettled(
    spaces.map(async (space): Promise<SpaceActivity> => {
      const [rooms, chat, streams] = await Promise.all([
        api.rooms(space.id),
        api.chat(space.id).catch((): ChatActivity => ({ rooms: {}, mentions: {} })),
        api.streams(space.id, since).catch((): readonly RecentStream[] => []),
      ]);
      return { spaceId: space.id, rooms, chat, streams };
    }),
  );
  const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  return serverSummary(origin, serverName, ok);
}
