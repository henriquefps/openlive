// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ChatRetentionDays,
  Preset,
  Role,
  RoomCapabilities,
  RoomKind,
  RoomSettings,
  RoomVisibility,
} from '@openlive/protocol';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { ME_KEY } from './auth.ts';
import { apiGet, apiSend } from './client.ts';

// Spaces, members, rooms, room access, invites and join requests: the REST API
// (apps/api/src/api/). Bodies mirror the API's Zod schemas; errors are ApiError
// with the code the API returned, for translateError.

/** The limits a space or room sets itself (settings_json); absent keys follow the level above. */
export interface LimitSettings {
  maxStreams?: number;
  maxViewersPerStream?: number;
  maxBitrateKbps?: number;
  allowedPresets?: Preset[];
  /** A room's capabilities; for a space, the ones its rooms may have (absent: all). */
  capabilities?: RoomCapabilities;
  /** A room's chat retention (default 30); for a space, the longest its rooms may keep. */
  chatRetentionDays?: ChatRetentionDays;
  /** A room's: whether guests write in the chat (default true). */
  guestsCanWrite?: boolean;
}

export interface SpaceSettings extends LimitSettings {
  /** Default true (matrix 6.4.4, "configurable"). */
  membersCanInviteGuests?: boolean;
  /** Default 12, at most 24. */
  quickRoomHours?: number;
}

/** A settings PATCH: keys sent as null are removed (back to the level above). */
export type SettingsPatch<S> = { [K in keyof S]?: S[K] | null };

export interface Space {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  plan: string;
  settings: SpaceSettings;
  createdAt: number;
  /** The caller's role; null for a platform admin who is not a member. */
  role: Role | null;
  /** The platform ceilings lowered by the space's own settings. */
  effectiveSettings: RoomSettings;
  /** The capabilities the platform allows: what the space settings may allow. */
  platformCapabilities?: RoomCapabilities;
}

export interface Member {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: Role;
  invitedBy: string | null;
  joinedAt: number;
  bannedAt: number | null;
}

export interface Room {
  id: string;
  spaceId: string;
  kind: RoomKind;
  name: string;
  slug: string;
  /** A quick room's join code (OL-4821-0937); null for fixed rooms. */
  code: string | null;
  visibility: RoomVisibility;
  settings: LimitSettings;
  createdBy: string | null;
  createdAt: number;
  lastActiveAt: number | null;
  /** Hard expiry of a quick room; null for fixed rooms. */
  expiresAt: number | null;
  archivedAt: number | null;
  effectiveSettings: RoomSettings;
}

export interface RoomAccess {
  userId: string;
  canView: boolean;
  canStream: boolean;
  grantedBy: string | null;
  grantedAt: number;
  expiresAt: number | null;
}

export interface Invite {
  id: string;
  spaceId: string;
  roomId: string | null;
  role: 'member' | 'guest';
  canStream: boolean;
  requiresApproval: boolean;
  maxUses: number;
  uses: number;
  expiresAt: number;
  createdBy: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface InvitePreview {
  spaceName: string;
  roomName: string | null;
  role: 'member' | 'guest';
  canStream: boolean;
  requiresApproval: boolean;
  expiresAt: number;
}

export type JoinRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';

export interface JoinRequest {
  id: string;
  spaceId: string;
  roomId: string | null;
  userId: string;
  displayName: string | null;
  inviteId: string | null;
  status: JoinRequestStatus;
  decidedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export type AcceptResult =
  | { status: 'joined'; spaceId: string; roomId: string | null; role: 'member' | 'guest' }
  | { status: 'pending'; joinRequest: JoinRequest };

const id = encodeURIComponent;

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
  queryFn: async () => (await apiGet<{ spaces: Space[] }>('/api/spaces')).spaces,
});

export const spaceQuery = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.space(spaceId),
    queryFn: async () => (await apiGet<{ space: Space }>(`/api/spaces/${id(spaceId)}`)).space,
  });

export const membersQuery = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.members(spaceId),
    queryFn: async () =>
      (await apiGet<{ members: Member[] }>(`/api/spaces/${id(spaceId)}/members`)).members,
  });

export const roomsQuery = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.rooms(spaceId),
    queryFn: async () =>
      (await apiGet<{ rooms: Room[] }>(`/api/spaces/${id(spaceId)}/rooms`)).rooms,
  });

export const roomQuery = (roomId: string) =>
  queryOptions({
    queryKey: spaceKeys.room(roomId),
    queryFn: async () => (await apiGet<{ room: Room }>(`/api/rooms/${id(roomId)}`)).room,
  });

export const roomAccessQuery = (roomId: string) =>
  queryOptions({
    queryKey: spaceKeys.access(roomId),
    queryFn: async () =>
      (await apiGet<{ access: RoomAccess[] }>(`/api/rooms/${id(roomId)}/access`)).access,
  });

export const invitesQuery = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.invites(spaceId),
    queryFn: async () =>
      (await apiGet<{ invites: Invite[] }>(`/api/spaces/${id(spaceId)}/invites`)).invites,
  });

export const joinRequestsQuery = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.joinRequests(spaceId),
    queryFn: async () =>
      (
        await apiGet<{ joinRequests: JoinRequest[] }>(
          `/api/spaces/${id(spaceId)}/join-requests?status=pending`,
        )
      ).joinRequests,
  });

export const invitePreviewQuery = (token: string) =>
  queryOptions({
    queryKey: spaceKeys.invite(token),
    queryFn: () => apiGet<{ invite: InvitePreview; pending: boolean }>(`/api/invites/${id(token)}`),
    retry: false,
  });

// --- plain calls ---

export const createSpace = async (input: { name: string; slug: string }) =>
  (await apiSend<{ space: Space }>('POST', '/api/spaces', input)).space;

export const updateSpace = async (
  spaceId: string,
  input: { name?: string; settings?: SettingsPatch<SpaceSettings> },
) => (await apiSend<{ space: Space }>('PATCH', `/api/spaces/${id(spaceId)}`, input)).space;

export const deleteSpace = (spaceId: string) => apiSend('DELETE', `/api/spaces/${id(spaceId)}`);

export const transferSpace = async (spaceId: string, userId: string) =>
  (await apiSend<{ space: Space }>('POST', `/api/spaces/${id(spaceId)}/transfer`, { userId }))
    .space;

export const changeRole = async (
  spaceId: string,
  userId: string,
  role: 'admin' | 'member' | 'guest',
) =>
  (
    await apiSend<{ member: Member }>('PATCH', `/api/spaces/${id(spaceId)}/members/${id(userId)}`, {
      role,
    })
  ).member;

export const setBanned = async (spaceId: string, userId: string, banned: boolean) =>
  (
    await apiSend<{ member: Member }>(
      banned ? 'POST' : 'DELETE',
      `/api/spaces/${id(spaceId)}/members/${id(userId)}/ban`,
    )
  ).member;

/** Leave (userId is the caller) or remove someone from the space. */
export const removeMember = (spaceId: string, userId: string) =>
  apiSend('DELETE', `/api/spaces/${id(spaceId)}/members/${id(userId)}`);

export const createFixedRoom = async (
  spaceId: string,
  input: { name: string; slug: string; visibility: RoomVisibility; settings?: LimitSettings },
) => (await apiSend<{ room: Room }>('POST', `/api/spaces/${id(spaceId)}/rooms`, input)).room;

export const createQuickRoom = (input: {
  spaceId: string;
  name?: string;
  capabilities?: RoomCapabilities;
}) => apiSend<{ room: Room; code: string }>('POST', '/api/rooms/quick', input);

export interface JoinByCodeResult {
  room: Room;
  /** Null for a guest of this room only, who cannot see the space. */
  spaceSlug: string | null;
  role: Role;
  /** Whether the code gave a room grant (the caller is not a member of the space). */
  granted: boolean;
}

/** Enter a quick room by its code, in any form people type it. */
export const joinRoomByCode = (code: string) =>
  apiSend<JoinByCodeResult>('POST', '/api/rooms/join', { code });

export const updateRoom = async (
  roomId: string,
  input: {
    name?: string;
    slug?: string;
    visibility?: RoomVisibility;
    settings?: SettingsPatch<LimitSettings>;
  },
) => (await apiSend<{ room: Room }>('PATCH', `/api/rooms/${id(roomId)}`, input)).room;

/** Archive a fixed room or end a quick room early. */
export const archiveRoom = (roomId: string) => apiSend('DELETE', `/api/rooms/${id(roomId)}`);

export const grantRoomAccess = async (
  roomId: string,
  userId: string,
  input: { canView?: boolean; canStream?: boolean; expiresAt?: number | null },
) =>
  (
    await apiSend<{ access: RoomAccess }>(
      'PUT',
      `/api/rooms/${id(roomId)}/access/${id(userId)}`,
      input,
    )
  ).access;

export const revokeRoomAccess = (roomId: string, userId: string) =>
  apiSend('DELETE', `/api/rooms/${id(roomId)}/access/${id(userId)}`);

export interface CreateInviteInput {
  roomId?: string | null;
  role: 'member' | 'guest';
  canStream?: boolean;
  requiresApproval?: boolean;
  maxUses?: number;
  expiresInHours?: number;
}

/** The token is in this response only; the API keeps its hash. */
export const createInvite = (spaceId: string, input: CreateInviteInput) =>
  apiSend<{ invite: Invite; token: string }>('POST', `/api/spaces/${id(spaceId)}/invites`, input);

export const revokeInvite = (inviteId: string) => apiSend('DELETE', `/api/invites/${id(inviteId)}`);

export const acceptInvite = (token: string) =>
  apiSend<AcceptResult>('POST', `/api/invites/${id(token)}/accept`);

export const decideJoinRequest = async (joinRequestId: string, decision: 'approve' | 'reject') =>
  (
    await apiSend<{ joinRequest: JoinRequest }>(
      'POST',
      `/api/join-requests/${id(joinRequestId)}/${decision}`,
    )
  ).joinRequest;

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
