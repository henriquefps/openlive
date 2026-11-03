// SPDX-License-Identifier: AGPL-3.0-only
import {
  acceptInvite,
  chatUnread,
  getInvitePreview,
  listRooms,
  listSpaces,
} from '@openlive/client';
import { onlineManager, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import { ApiError, type ApiClient } from './lib/api.ts';
import { keys, type Scope } from './lib/cache.ts';
import { useInstances } from './state.tsx';

// Every REST read of the screens as a query. A screen shows what the cache has at once (the last
// answer, from this run or saved on the phone) and the query revalidates it in the background:
// when the data is older than its staleTime and the screen opens, when the app comes back to the
// front, when the network returns, and on pull to refresh (`refetch`). Keys: lib/cache.ts.

const MINUTE = 60_000;

/** Who is signed in to `origin`: the scope of its cache entries; null when signed out. */
export function useScope(origin: string): Scope | null {
  const { instances } = useInstances();
  const userId = instances.find((i) => i.origin === origin)?.user?.userId;
  return useMemo(() => (userId ? { origin, userId } : null), [origin, userId]);
}

/** A key for a screen that has no signed-in user: never fetched, never saved. */
const signedOutKey = (origin: string) => ['ol', origin, '-', 'signed-out'] as const;

/** Runs `call` with the instance's client (and its current token); 401 when signed out. */
function useCall(origin: string) {
  const { client } = useInstances();
  return useMemo(
    () =>
      async <T>(call: (api: ApiClient) => Promise<T>): Promise<T> => {
        const api = await client(origin);
        if (!api) throw new ApiError(401, { code: 'unauthenticated' });
        return call(api);
      },
    [client, origin],
  );
}

export function useSpaces(origin: string) {
  const scope = useScope(origin);
  const call = useCall(origin);
  return useQuery({
    queryKey: scope ? keys(scope).spaces() : signedOutKey(origin),
    queryFn: () => call(listSpaces),
    enabled: scope !== null,
    staleTime: MINUTE,
  });
}

export function useRooms(origin: string, spaceId: string) {
  const scope = useScope(origin);
  const call = useCall(origin);
  return useQuery({
    queryKey: scope ? keys(scope).rooms(spaceId) : signedOutKey(origin),
    queryFn: () => call((api) => listRooms(api, spaceId)),
    enabled: scope !== null,
    staleTime: 30_000,
  });
}

/** Unread chat counts by room. They are a separate call: a failure must not hide the rooms. */
export function useUnread(origin: string, spaceId: string) {
  const scope = useScope(origin);
  const call = useCall(origin);
  return useQuery({
    queryKey: scope ? keys(scope).unread(spaceId) : signedOutKey(origin),
    queryFn: () => call((api) => chatUnread(api, spaceId)),
    enabled: scope !== null,
    staleTime: 15_000,
  });
}

/** What an invite link offers. Not saved on the phone: an invite token is not for keeping. */
export function useInvitePreview(origin: string, token: string) {
  const scope = useScope(origin);
  const call = useCall(origin);
  return useQuery({
    queryKey: scope ? keys(scope).invite(token) : signedOutKey(origin),
    queryFn: async () => (await call((api) => getInvitePreview(api, token))).invite,
    enabled: scope !== null,
    staleTime: 5 * MINUTE,
    retry: false,
  });
}

/** Accepting an invite: a joined space changes the list of spaces, so that one is fetched again. */
export function useAcceptInvite(origin: string, token: string) {
  const scope = useScope(origin);
  const call = useCall(origin);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => call((api) => acceptInvite(api, token)),
    onSuccess: async (answer) => {
      if (answer.status === 'joined' && scope) {
        await queryClient.invalidateQueries({ queryKey: keys(scope).spaces() });
      }
    },
  });
}

/** Whether the phone has a network (TanStack Query's online state, from expo-network). */
export function useOnline(): boolean {
  return useSyncExternalStore(onlineManager.subscribe, () => onlineManager.isOnline());
}
