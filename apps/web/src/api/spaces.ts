// SPDX-License-Identifier: AGPL-3.0-only
import * as client from '@openlive/client';
import type { CreateInviteInput, Room, Space } from '@openlive/client';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { ME_KEY } from './auth.ts';
import { webApi } from './client.ts';

// Spaces, members, rooms, room access, invites and join requests as React Query queries and
// mutations over the shared REST calls in @openlive/client (api/spaces.ts).
// Errors are ApiError with the code the API returned, for translateError.

export type {
  AcceptResult,
  CreateInviteInput,
  Invite,
  InvitePreview,
  JoinByCodeResult,
  JoinRequest,
  JoinRequestStatus,
  LimitSettings,
  Member,
  Room,
  RoomAccess,
  SettingsPatch,
  Space,
  SpaceSettings,
} from '@openlive/client';

// --- query keys and queries ---

export const spaceKeys = {
  all: ['spaces'] as const,
  space: (spaceId: string) => ['space', spaceId] as const,
  members: (spaceId: string) => ['space', spaceId, 'members'] as const,
  rooms: (spaceId: string) => ['space', spaceId, 'rooms'] as const,
  invites: (spaceId: string) => ['space', spaceId, 'invites'] as const,
  joinRequests: (spaceId: string) => ['space', spaceId, 'joinRequests'] as const,
  room: (roomId: string) => ['room', roomId] as const,
  access: (roomId: string) => ['room', roomId, 'access'] as const,
  invite: (token: string) => ['invite', token] as const,
};

export const spacesQuery = queryOptions({
  queryKey: spaceKeys.all,
  queryFn: () => client.listSpaces(webApi),
});

export const spaceQuery = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.space(spaceId),
    queryFn: () => client.getSpace(webApi, spaceId),
  });

export const membersQuery = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.members(spaceId),
    queryFn: () => client.listMembers(webApi, spaceId),
  });

export const roomsQuery = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.rooms(spaceId),
    queryFn: () => client.listRooms(webApi, spaceId),
  });

export const roomQuery = (roomId: string) =>
  queryOptions({
    queryKey: spaceKeys.room(roomId),
    queryFn: () => client.getRoom(webApi, roomId),
  });

export const roomAccessQuery = (roomId: string) =>
  queryOptions({
    queryKey: spaceKeys.access(roomId),
    queryFn: () => client.listRoomAccess(webApi, roomId),
  });

export const invitesQuery = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.invites(spaceId),
    queryFn: () => client.listInvites(webApi, spaceId),
  });

export const joinRequestsQuery = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.joinRequests(spaceId),
    queryFn: () => client.listJoinRequests(webApi, spaceId),
  });

export const invitePreviewQuery = (token: string) =>
  queryOptions({
    queryKey: spaceKeys.invite(token),
    queryFn: () => client.getInvitePreview(webApi, token),
    retry: false,
  });

// --- plain calls, on the web's client ---

type Call<F> = F extends (api: client.ApiClient, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
const onWeb = <F extends (api: client.ApiClient, ...args: never[]) => unknown>(fn: F): Call<F> =>
  ((...args: never[]) => fn(webApi, ...args)) as Call<F>;

export const createSpace = onWeb(client.createSpace);
export const updateSpace = onWeb(client.updateSpace);
export const deleteSpace = onWeb(client.deleteSpace);
export const transferSpace = onWeb(client.transferSpace);
export const changeRole = onWeb(client.changeRole);
export const setBanned = onWeb(client.setBanned);
/** Leave (userId is the caller) or remove someone from the space. */
export const removeMember = onWeb(client.removeMember);
export const createFixedRoom = onWeb(client.createFixedRoom);
export const createQuickRoom = onWeb(client.createQuickRoom);
/** Enter a quick room by its code, in any form people type it. */
export const joinRoomByCode = onWeb(client.joinRoomByCode);
export const updateRoom = onWeb(client.updateRoom);
/** Archive a fixed room or end a quick room early. */
export const archiveRoom = onWeb(client.archiveRoom);
export const grantRoomAccess = onWeb(client.grantRoomAccess);
export const revokeRoomAccess = onWeb(client.revokeRoomAccess);
/** The token is in this response only; the API keeps its hash. */
export const createInvite = onWeb(client.createInvite);
export const revokeInvite = onWeb(client.revokeInvite);
export const acceptInvite = onWeb(client.acceptInvite);
export const decideJoinRequest = onWeb(client.decideJoinRequest);

/** The web link of an invite token (shown once, at creation). */
export const inviteUrl = (token: string, origin: string = window.location.origin) =>
  `${origin}/invite/${token}`;

/** The shareable link that joins a quick room by its code. */
export const joinUrl = (code: string, origin: string = window.location.origin) =>
  `${origin}/join/${code}`;

// --- mutation hooks: each refreshes what it changed ---

/**
 * A mutation that refreshes `keys` once it succeeds, then calls `after`. Unlike the callbacks
 * passed to `mutate`, `after` still runs when the component that started the mutation unmounted
 * meanwhile (for example a dialog in an empty state that the refreshed list replaces).
 */
function useInvalidating<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  keys: (args: TArgs, result: TResult) => readonly (readonly unknown[])[],
  after?: (result: TResult) => unknown,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, args) => {
      await Promise.all(
        keys(args, result).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      await after?.(result);
    },
  });
}

/** `onCreated` runs once the caller's memberships include the new space. */
export const useCreateSpace = (onCreated?: (space: Space) => unknown) =>
  useInvalidating(createSpace, () => [spaceKeys.all, ME_KEY], onCreated);

export const useUpdateSpace = (spaceId: string) =>
  useInvalidating(
    (input: Parameters<typeof updateSpace>[1]) => updateSpace(spaceId, input),
    () => [spaceKeys.space(spaceId), spaceKeys.rooms(spaceId), spaceKeys.all, ME_KEY],
  );

export const useDeleteSpace = (spaceId: string) =>
  useInvalidating(
    () => deleteSpace(spaceId),
    () => [spaceKeys.all, ME_KEY],
  );

export const useTransferSpace = (spaceId: string) =>
  useInvalidating(
    (userId: string) => transferSpace(spaceId, userId),
    () => [spaceKeys.space(spaceId), spaceKeys.members(spaceId), ME_KEY],
  );

export const useChangeRole = (spaceId: string) =>
  useInvalidating(
    ({ userId, role }: { userId: string; role: 'admin' | 'member' | 'guest' }) =>
      changeRole(spaceId, userId, role),
    () => [spaceKeys.members(spaceId)],
  );

export const useSetBanned = (spaceId: string) =>
  useInvalidating(
    ({ userId, banned }: { userId: string; banned: boolean }) => setBanned(spaceId, userId, banned),
    () => [spaceKeys.members(spaceId)],
  );

export const useRemoveMember = (spaceId: string) =>
  useInvalidating(
    (userId: string) => removeMember(spaceId, userId),
    () => [spaceKeys.members(spaceId), spaceKeys.all, ME_KEY],
  );

export const useCreateFixedRoom = (spaceId: string) =>
  useInvalidating(
    (input: Parameters<typeof createFixedRoom>[1]) => createFixedRoom(spaceId, input),
    () => [spaceKeys.rooms(spaceId)],
  );

export const useCreateQuickRoom = (spaceId: string) =>
  useInvalidating(
    (name: string | undefined) => createQuickRoom({ spaceId, ...(name ? { name } : {}) }),
    () => [spaceKeys.rooms(spaceId)],
  );

export const useUpdateRoom = (room: Pick<Room, 'id' | 'spaceId'>) =>
  useInvalidating(
    (input: Parameters<typeof updateRoom>[1]) => updateRoom(room.id, input),
    () => [spaceKeys.room(room.id), spaceKeys.rooms(room.spaceId)],
  );

export const useArchiveRoom = (room: Pick<Room, 'id' | 'spaceId'>) =>
  useInvalidating(
    () => archiveRoom(room.id),
    () => [spaceKeys.rooms(room.spaceId)],
  );

export const useGrantRoomAccess = (roomId: string) =>
  useInvalidating(
    ({ userId, ...input }: { userId: string } & Parameters<typeof grantRoomAccess>[2]) =>
      grantRoomAccess(roomId, userId, input),
    () => [spaceKeys.access(roomId)],
  );

export const useRevokeRoomAccess = (roomId: string) =>
  useInvalidating(
    (userId: string) => revokeRoomAccess(roomId, userId),
    () => [spaceKeys.access(roomId)],
  );

export const useCreateInvite = (spaceId: string) =>
  useInvalidating(
    (input: CreateInviteInput) => createInvite(spaceId, input),
    () => [spaceKeys.invites(spaceId)],
  );

export const useRevokeInvite = (spaceId: string) =>
  useInvalidating(revokeInvite, () => [spaceKeys.invites(spaceId)]);

export const useAcceptInvite = () => useInvalidating(acceptInvite, () => [spaceKeys.all, ME_KEY]);

export const useDecideJoinRequest = (spaceId: string) =>
  useInvalidating(
    ({ joinRequestId, decision }: { joinRequestId: string; decision: 'approve' | 'reject' }) =>
      decideJoinRequest(joinRequestId, decision),
    () => [spaceKeys.joinRequests(spaceId), spaceKeys.members(spaceId)],
  );
