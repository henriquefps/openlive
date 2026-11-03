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
import type { ApiClient } from './client.ts';

// Spaces, members, rooms, room access, invites and join requests: the REST API
// (apps/api/src/api/). Bodies mirror the API's Zod schemas; errors are ApiError
// with the code the API returned. Every call takes the ApiClient to use (api/client.ts).

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

// --- reads ---

export const listSpaces = async (api: ApiClient) =>
  (await api.get<{ spaces: Space[] }>('/api/spaces')).spaces;

export const getSpace = async (api: ApiClient, spaceId: string) =>
  (await api.get<{ space: Space }>(`/api/spaces/${id(spaceId)}`)).space;

export const listMembers = async (api: ApiClient, spaceId: string) =>
  (await api.get<{ members: Member[] }>(`/api/spaces/${id(spaceId)}/members`)).members;

export const listRooms = async (api: ApiClient, spaceId: string) =>
  (await api.get<{ rooms: Room[] }>(`/api/spaces/${id(spaceId)}/rooms`)).rooms;

export const getRoom = async (api: ApiClient, roomId: string) =>
  (await api.get<{ room: Room }>(`/api/rooms/${id(roomId)}`)).room;

export const listRoomAccess = async (api: ApiClient, roomId: string) =>
  (await api.get<{ access: RoomAccess[] }>(`/api/rooms/${id(roomId)}/access`)).access;

export const listInvites = async (api: ApiClient, spaceId: string) =>
  (await api.get<{ invites: Invite[] }>(`/api/spaces/${id(spaceId)}/invites`)).invites;

/** The join requests still waiting for a decision. */
export const listJoinRequests = async (api: ApiClient, spaceId: string) =>
  (
    await api.get<{ joinRequests: JoinRequest[] }>(
      `/api/spaces/${id(spaceId)}/join-requests?status=pending`,
    )
  ).joinRequests;

export const getInvitePreview = (api: ApiClient, token: string) =>
  api.get<{ invite: InvitePreview; pending: boolean }>(`/api/invites/${id(token)}`);

// --- changes ---

export const createSpace = async (api: ApiClient, input: { name: string; slug: string }) =>
  (await api.send<{ space: Space }>('POST', '/api/spaces', input)).space;

export const updateSpace = async (
  api: ApiClient,
  spaceId: string,
  input: { name?: string; settings?: SettingsPatch<SpaceSettings> },
) => (await api.send<{ space: Space }>('PATCH', `/api/spaces/${id(spaceId)}`, input)).space;

export const deleteSpace = (api: ApiClient, spaceId: string) =>
  api.send('DELETE', `/api/spaces/${id(spaceId)}`);

export const transferSpace = async (api: ApiClient, spaceId: string, userId: string) =>
  (await api.send<{ space: Space }>('POST', `/api/spaces/${id(spaceId)}/transfer`, { userId }))
    .space;

export const changeRole = async (
  api: ApiClient,
  spaceId: string,
  userId: string,
  role: 'admin' | 'member' | 'guest',
) =>
  (
    await api.send<{ member: Member }>(
      'PATCH',
      `/api/spaces/${id(spaceId)}/members/${id(userId)}`,
      {
        role,
      },
    )
  ).member;

export const setBanned = async (api: ApiClient, spaceId: string, userId: string, banned: boolean) =>
  (
    await api.send<{ member: Member }>(
      banned ? 'POST' : 'DELETE',
      `/api/spaces/${id(spaceId)}/members/${id(userId)}/ban`,
    )
  ).member;

/** Leave (userId is the caller) or remove someone from the space. */
export const removeMember = (api: ApiClient, spaceId: string, userId: string) =>
  api.send('DELETE', `/api/spaces/${id(spaceId)}/members/${id(userId)}`);

export const createFixedRoom = async (
  api: ApiClient,
  spaceId: string,
  input: { name: string; slug: string; visibility: RoomVisibility; settings?: LimitSettings },
) => (await api.send<{ room: Room }>('POST', `/api/spaces/${id(spaceId)}/rooms`, input)).room;

export const createQuickRoom = (
  api: ApiClient,
  input: {
    spaceId: string;
    name?: string;
    capabilities?: RoomCapabilities;
  },
) => api.send<{ room: Room; code: string }>('POST', '/api/rooms/quick', input);

export interface JoinByCodeResult {
  room: Room;
  /** Null for a guest of this room only, who cannot see the space. */
  spaceSlug: string | null;
  role: Role;
  /** Whether the code gave a room grant (the caller is not a member of the space). */
  granted: boolean;
}

/** Enter a quick room by its code, in any form people type it. */
export const joinRoomByCode = (api: ApiClient, code: string) =>
  api.send<JoinByCodeResult>('POST', '/api/rooms/join', { code });

export const updateRoom = async (
  api: ApiClient,
  roomId: string,
  input: {
    name?: string;
    slug?: string;
    visibility?: RoomVisibility;
    settings?: SettingsPatch<LimitSettings>;
  },
) => (await api.send<{ room: Room }>('PATCH', `/api/rooms/${id(roomId)}`, input)).room;

/** Archive a fixed room or end a quick room early. */
export const archiveRoom = (api: ApiClient, roomId: string) =>
  api.send('DELETE', `/api/rooms/${id(roomId)}`);

export const grantRoomAccess = async (
  api: ApiClient,
  roomId: string,
  userId: string,
  input: { canView?: boolean; canStream?: boolean; expiresAt?: number | null },
) =>
  (
    await api.send<{ access: RoomAccess }>(
      'PUT',
      `/api/rooms/${id(roomId)}/access/${id(userId)}`,
      input,
    )
  ).access;

export const revokeRoomAccess = (api: ApiClient, roomId: string, userId: string) =>
  api.send('DELETE', `/api/rooms/${id(roomId)}/access/${id(userId)}`);

export interface CreateInviteInput {
  roomId?: string | null;
  role: 'member' | 'guest';
  canStream?: boolean;
  requiresApproval?: boolean;
  maxUses?: number;
  expiresInHours?: number;
}

/** The token is in this response only; the API keeps its hash. */
export const createInvite = (api: ApiClient, spaceId: string, input: CreateInviteInput) =>
  api.send<{ invite: Invite; token: string }>('POST', `/api/spaces/${id(spaceId)}/invites`, input);

export const revokeInvite = (api: ApiClient, inviteId: string) =>
  api.send('DELETE', `/api/invites/${id(inviteId)}`);

export const acceptInvite = (api: ApiClient, token: string) =>
  api.send<AcceptResult>('POST', `/api/invites/${id(token)}/accept`);

export const decideJoinRequest = async (
  api: ApiClient,
  joinRequestId: string,
  decision: 'approve' | 'reject',
) =>
  (
    await api.send<{ joinRequest: JoinRequest }>(
      'POST',
      `/api/join-requests/${id(joinRequestId)}/${decision}`,
    )
  ).joinRequest;
