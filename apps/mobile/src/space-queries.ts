// SPDX-License-Identifier: AGPL-3.0-only
import {
  archiveRoom,
  changeRole,
  createFixedRoom,
  createInvite,
  createQuickRoom,
  type CreateInviteInput,
  decideJoinRequest,
  deleteSpace,
  getRoom,
  getSpace,
  grantRoomAccess,
  getSpaceStatus,
  listInvites,
  listJoinRequests,
  listMembers,
  listRoomAccess,
  removeMember,
  revokeInvite,
  revokeRoomAccess,
  type Room,
  setBanned,
  type SettingsPatch,
  type SpaceSettings,
  type StatusRange,
  transferSpace,
  updateRoom,
  updateSpace,
} from '@openlive/client';
import type { RoomVisibility } from '@openlive/protocol';
import type { LimitSettings } from '@openlive/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keys, type Scope } from './lib/cache.ts';
import {
  type SpaceMutation,
  spaceEntries,
  staleAfter,
  staleAfterLeaving,
} from './lib/space-keys.ts';
import { signedOutKey, useCall, useScope } from './queries.ts';

// The space page's reads and changes as typed queries and mutations (the web's api/spaces.ts and
// api/status.ts over the shared calls in @openlive/client). Keys: lib/cache.ts. Each mutation
// marks what it changed as stale (lib/space-keys.ts) and waits for the refetch, so the list on
// screen is the new one when the mutation settles. Reads of other users' data are not kept long.

const SOON = 30_000;

export function useSpace(origin: string, spaceId: string) {
  const scope = useScope(origin);
  const call = useCall(origin);
  return useQuery({
    queryKey: scope ? keys(scope).space(spaceId) : signedOutKey(origin),
    queryFn: () => call((api) => getSpace(api, spaceId)),
    enabled: scope !== null,
    staleTime: SOON,
  });
}

export function useMembers(origin: string, spaceId: string, enabled = true) {
  const scope = useScope(origin);
  const call = useCall(origin);
  return useQuery({
    queryKey: scope ? keys(scope).members(spaceId) : signedOutKey(origin),
    queryFn: () => call((api) => listMembers(api, spaceId)),
    enabled: scope !== null && enabled,
    staleTime: SOON,
  });
}

export function useInvites(origin: string, spaceId: string, enabled = true) {
  const scope = useScope(origin);
  const call = useCall(origin);
  return useQuery({
    queryKey: scope ? keys(scope).invites(spaceId) : signedOutKey(origin),
    queryFn: () => call((api) => listInvites(api, spaceId)),
    enabled: scope !== null && enabled,
    staleTime: SOON,
  });
}

/** The pending join requests; only owners and admins may ask (`enabled`). */
export function useJoinRequests(origin: string, spaceId: string, enabled = true) {
  const scope = useScope(origin);
  const call = useCall(origin);
  return useQuery({
    queryKey: scope ? keys(scope).joinRequests(spaceId) : signedOutKey(origin),
    queryFn: () => call((api) => listJoinRequests(api, spaceId)),
    enabled: scope !== null && enabled,
    staleTime: 15_000,
  });
}

/** The space's status for a range; read again every minute while it is on screen, as the web. */
export function useSpaceStatus(origin: string, spaceId: string, range: StatusRange) {
  const scope = useScope(origin);
  const call = useCall(origin);
  return useQuery({
    queryKey: scope ? keys(scope).status(spaceId, range) : signedOutKey(origin),
    queryFn: () => call((api) => getSpaceStatus(api, spaceId, range)),
    enabled: scope !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** Marks `stale` as stale and waits for the ones on screen to be read again. */
async function refresh(
  queryClient: ReturnType<typeof useQueryClient>,
  stale: readonly (readonly unknown[])[],
) {
  await Promise.all(stale.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/** Every change a space page offers, each refreshing what it touched. */
export function useSpaceActions(origin: string, spaceId: string) {
  const scope = useScope(origin);
  const call = useCall(origin);
  const queryClient = useQueryClient();
  const done = async (mutation: SpaceMutation) => {
    if (scope) await refresh(queryClient, staleAfter(scope, spaceId, mutation));
  };
  /** The space is gone for this person: its entries go, the list of spaces is read again. */
  const gone = async (s: Scope | null) => {
    if (!s) return;
    await Promise.all(
      spaceEntries(s, spaceId).map((queryKey) => queryClient.cancelQueries({ queryKey })),
    );
    for (const queryKey of spaceEntries(s, spaceId)) queryClient.removeQueries({ queryKey });
    await refresh(queryClient, staleAfterLeaving(s));
  };

  return {
    updateSpace: useMutation({
      mutationFn: (input: { name?: string; settings?: SettingsPatch<SpaceSettings> }) =>
        call((api) => updateSpace(api, spaceId, input)),
      onSuccess: () => done('updateSpace'),
    }),
    deleteSpace: useMutation({
      mutationFn: () => call((api) => deleteSpace(api, spaceId)),
      onSuccess: () => gone(scope),
    }),
    /** Leave (userId is the caller) or remove someone: leaving drops the space. */
    leaveSpace: useMutation({
      mutationFn: (selfId: string) => call((api) => removeMember(api, spaceId, selfId)),
      onSuccess: () => gone(scope),
    }),
    transfer: useMutation({
      mutationFn: (userId: string) => call((api) => transferSpace(api, spaceId, userId)),
      onSuccess: () => done('transferSpace'),
    }),
    changeRole: useMutation({
      mutationFn: (v: { userId: string; role: 'admin' | 'member' | 'guest' }) =>
        call((api) => changeRole(api, spaceId, v.userId, v.role)),
      onSuccess: () => done('changeRole'),
    }),
    setBanned: useMutation({
      mutationFn: (v: { userId: string; banned: boolean }) =>
        call((api) => setBanned(api, spaceId, v.userId, v.banned)),
      onSuccess: () => done('setBanned'),
    }),
    removeMember: useMutation({
      mutationFn: (userId: string) => call((api) => removeMember(api, spaceId, userId)),
      onSuccess: () => done('removeMember'),
    }),
    createFixedRoom: useMutation({
      mutationFn: (input: {
        name: string;
        slug: string;
        visibility: RoomVisibility;
        settings?: LimitSettings;
      }) => call((api) => createFixedRoom(api, spaceId, input)),
      onSuccess: () => done('createRoom'),
    }),
    createQuickRoom: useMutation({
      mutationFn: () => call((api) => createQuickRoom(api, { spaceId })),
      onSuccess: () => done('createRoom'),
    }),
    createInvite: useMutation({
      mutationFn: (input: CreateInviteInput) => call((api) => createInvite(api, spaceId, input)),
      onSuccess: () => done('createInvite'),
    }),
    revokeInvite: useMutation({
      mutationFn: (inviteId: string) => call((api) => revokeInvite(api, inviteId)),
      onSuccess: () => done('revokeInvite'),
    }),
    decideJoinRequest: useMutation({
      mutationFn: (v: { joinRequestId: string; decision: 'approve' | 'reject' }) =>
        call((api) => decideJoinRequest(api, v.joinRequestId, v.decision)),
      onSuccess: () => done('decideJoinRequest'),
    }),
  };
}

// --- one room's management (the web's RoomView header: features, access, archive or end) ---

/** The room's own record: kind, code, visibility and settings (the room socket has no code). */
export function useRoomInfo(origin: string, roomId: string, enabled = true) {
  const scope = useScope(origin);
  const call = useCall(origin);
  return useQuery({
    queryKey: scope ? keys(scope).roomInfo(roomId) : signedOutKey(origin),
    queryFn: () => call((api) => getRoom(api, roomId)),
    enabled: scope !== null && enabled,
    staleTime: SOON,
  });
}

export function useRoomAccess(origin: string, roomId: string, enabled = true) {
  const scope = useScope(origin);
  const call = useCall(origin);
  return useQuery({
    queryKey: scope ? keys(scope).roomAccess(roomId) : signedOutKey(origin),
    queryFn: () => call((api) => listRoomAccess(api, roomId)),
    enabled: scope !== null && enabled,
    staleTime: 0,
  });
}

/** Features, access and closing a room, each refreshing what it touched. */
export function useRoomActions(origin: string, room: Pick<Room, 'id' | 'spaceId'>) {
  const scope = useScope(origin);
  const call = useCall(origin);
  const queryClient = useQueryClient();
  const refreshKeys = async (stale: readonly (readonly unknown[])[]) => {
    await refresh(queryClient, stale);
  };
  return {
    update: useMutation({
      mutationFn: (input: Parameters<typeof updateRoom>[2]) =>
        call((api) => updateRoom(api, room.id, input)),
      onSuccess: async () => {
        if (scope) {
          const k = keys(scope);
          await refreshKeys([k.roomInfo(room.id), k.rooms(room.spaceId)]);
        }
      },
    }),
    /** Archive a fixed room or end a quick one: the room leaves the space's list. */
    close: useMutation({
      mutationFn: () => call((api) => archiveRoom(api, room.id)),
      onSuccess: async () => {
        if (scope) await refreshKeys([keys(scope).rooms(room.spaceId)]);
      },
    }),
    grant: useMutation({
      mutationFn: ({
        userId,
        ...input
      }: { userId: string } & Parameters<typeof grantRoomAccess>[3]) =>
        call((api) => grantRoomAccess(api, room.id, userId, input)),
      onSuccess: async () => {
        if (scope) await refreshKeys([keys(scope).roomAccess(room.id)]);
      },
    }),
    revoke: useMutation({
      mutationFn: (userId: string) => call((api) => revokeRoomAccess(api, room.id, userId)),
      onSuccess: async () => {
        if (scope) await refreshKeys([keys(scope).roomAccess(room.id)]);
      },
    }),
  };
}
