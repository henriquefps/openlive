// SPDX-License-Identifier: AGPL-3.0-only
import type { Device, Preset, Role, RoomCapabilities } from '@openlive/protocol';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import {
  type Budget,
  type BudgetKind,
  MAX_PRESET_SEND_KBPS,
  PRESET_CODECS,
  type PresetCodec,
  type QuotaLevel,
  type QuotaMode,
} from '@openlive/usage';
import { ME_KEY } from './auth.ts';
import { apiGet, apiSend } from './client.ts';
import { queryClient } from './query-client.ts';

// The platform admin: the install-code claim, the month's usage, the
// platform ceilings and space suspension. The API answers 403 to anyone else.

export const RESOLUTIONS = ['1080p', '1440p', '2160p'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export const FRAME_RATES = [30, 60, 120] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

export interface PlatformSettings {
  maxResolution: Resolution;
  maxFps: FrameRate;
  maxBitrateKbps: number;
  maxViewersPerStream: number;
  maxStreamsPerRoom: number;
  /** Cameras on at once in a room's voice channel (default 6). */
  maxCamerasPerRoom: number;
  /** The monthly limit: the free tier, a preset, a custom number of GB, or none. */
  budget: Budget;
  /** What happens at the limit; unused when the budget is unlimited. */
  quotaMode: QuotaMode;
  /** Enter economy mode above 90 % of the limit. */
  autoEconomy: boolean;
  /** Brake 5: pause the video of a tab hidden for 60 s. */
  backgroundPause: boolean;
  /** Brake 6: "Still watching?" after 2 h without interaction. */
  idleCheck: boolean;
  cycleResetDay: number;
  overheads: boolean;
  /** Who may create an account: people with an invite or a room code, or anyone. */
  signup: 'invite_only' | 'open';
  /** Who may create a space: the platform admin, or anyone signed in. */
  spaceCreation: 'admin_only' | 'members';
  /** The room capabilities spaces and rooms may have. */
  capabilities: RoomCapabilities;
  /** Streams also send their top layer in AV1 for viewers that decode it. */
  allowAv1: boolean;
  /**
   * Per preset, with AV1 allowed: `av1Save` (the default when absent),
   * `av1Quality` or `h264` (H.264 only).
   */
  presetCodecs: Partial<Record<Preset, PresetCodec>>;
}

export { PRESET_CODECS, type PresetCodec };

/** The presets a resolution and fps ceiling allows, as the API derives them. */
export function presetsFor(resolution: Resolution, fps: FrameRate): Preset[] {
  const height = { '1080p': 1080, '1440p': 1440, '2160p': 2160 }[resolution];
  const out: Preset[] = ['text'];
  if (fps >= 60) out.push('game');
  if (fps >= 60 && height >= 1440) out.push('max');
  if (fps >= 60 && height >= 2160) out.push('native');
  if (fps >= 120) out.push('game120');
  if (fps >= 120 && height >= 1440) out.push('max120');
  return out;
}

/** The bounds the API enforces on PUT /api/admin/settings (apps/api/src/api/admin.ts). */
export const SETTINGS_BOUNDS = {
  maxBitrateKbps: { min: 1_000, max: MAX_PRESET_SEND_KBPS },
  maxViewersPerStream: { min: 1, max: 50 },
  maxStreamsPerRoom: { min: 1, max: 20 },
  maxCamerasPerRoom: { min: 0, max: 12 },
  cycleResetDay: { min: 1, max: 31 },
} as const;

export interface SpaceUsage {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  suspendedAt: number | null;
  members: number;
  estimatedGB: number;
  viewerMinutes: number;
  streamMinutes: number;
}

export interface Overview {
  cycle: { start: string; end: string; daysLeft: number };
  quota: {
    budget: BudgetKind;
    /** The monthly limit in GB, null when unlimited. */
    quotaGB: number | null;
    freeTierGB: number;
    mode: QuotaMode;
    autoEconomy: boolean;
    level: QuotaLevel;
    usedGB: number;
    /** null when unlimited. */
    usedFraction: number | null;
    source: 'estimate' | 'real';
    freeTierExceeded: boolean;
    economyMode: boolean;
    blockNewStreams: boolean;
    /** The cost so far, above the free tier. */
    cost: { gbAboveFree: number; usd: number };
    /** Linear on the cycle's elapsed fraction; stops at the limit in block mode. */
    projection: {
      projectedGB: number;
      cappedAtLimit: boolean;
      cost: { gbAboveFree: number; usd: number };
    };
  };
  usage: {
    estimatedGB: number;
    /** null until the usage cron has stored Cloudflare's numbers for this cycle. */
    realGB: number | null;
    viewerMinutes: number;
    streamMinutes: number;
  };
  spaces: SpaceUsage[];
}

const ADMIN_KEY = ['admin'] as const;

export const overviewQuery = queryOptions({
  queryKey: [...ADMIN_KEY, 'overview'],
  queryFn: () => apiGet<Overview>('/api/admin/overview'),
  refetchInterval: 60_000,
});

export const settingsQuery = queryOptions({
  queryKey: [...ADMIN_KEY, 'settings'],
  queryFn: async () =>
    (await apiGet<{ settings: PlatformSettings }>('/api/admin/settings')).settings,
});

export async function saveSettings(settings: PlatformSettings): Promise<PlatformSettings> {
  const saved = (
    await apiSend<{ settings: PlatformSettings }>('PUT', '/api/admin/settings', settings)
  ).settings;
  queryClient.setQueryData(settingsQuery.queryKey, saved);
  // The quota mode and the cycle day change the overview and everyone's banner; the access
  // policies change what the login page says and who sees "Create space".
  await queryClient.invalidateQueries({ queryKey: ADMIN_KEY });
  await queryClient.invalidateQueries({ queryKey: ME_KEY, exact: true });
  await queryClient.invalidateQueries({ queryKey: ['auth', 'policy'] });
  return saved;
}

export async function setSpaceSuspended(spaceId: string, suspended: boolean): Promise<void> {
  const action = suspended ? 'suspend' : 'unsuspend';
  await apiSend('POST', `/api/admin/spaces/${encodeURIComponent(spaceId)}/${action}`);
  await queryClient.invalidateQueries({ queryKey: overviewQuery.queryKey });
}

// Platform user management: every account, its spaces, a platform-wide ban and
// deletion. Metadata only: never stream content, never IPs.

export const USER_FILTERS = ['all', 'no_space', 'banned', 'admins'] as const;
export type UserFilter = (typeof USER_FILTERS)[number];

export type Provider = 'discord' | 'email';

export interface UserSpace {
  id: string;
  name: string;
  slug: string;
  role: Role;
  /** Set when that space banned the account. */
  bannedAt: number | null;
}

export interface AdminUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  primaryEmail: string | null;
  providers: Provider[];
  isPlatformAdmin: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  /** Set while the account is banned from the whole instance. */
  bannedAt: number | null;
  deviceCount: number;
  spaces: UserSpace[];
}

export interface AdminSession {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string | null;
}

export interface AdminAuditEntry {
  id: string;
  action: string;
  spaceId: string | null;
  spaceName: string | null;
  actorId: string | null;
  actorName: string | null;
  target: string | null;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface AdminUserStream {
  streamId: string;
  preset: Preset;
  sourceKind: 'screen' | 'window';
  startedAt: number;
  viewerCount: number;
  roomId: string;
  roomName: string;
  spaceId: string;
  spaceName: string;
}

export interface AdminUserDetail extends AdminUser {
  bannedReason: string | null;
  bannedBy: string | null;
  sessions: AdminSession[];
  devices: Device[];
  audit: AdminAuditEntry[];
  streams: AdminUserStream[];
}

const USERS_KEY = [...ADMIN_KEY, 'users'] as const;

export const usersQuery = (filter: UserFilter, query: string) =>
  infiniteQueryOptions({
    queryKey: [...USERS_KEY, 'list', filter, query],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ filter });
      if (query) params.set('query', query);
      if (pageParam) params.set('cursor', pageParam);
      return apiGet<{ users: AdminUser[]; nextCursor: string | null }>(
        `/api/admin/users?${params}`,
      );
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const userQuery = (userId: string) =>
  queryOptions({
    queryKey: [...USERS_KEY, 'detail', userId],
    queryFn: async () =>
      (await apiGet<{ user: AdminUserDetail }>(`/api/admin/users/${encodeURIComponent(userId)}`))
        .user,
  });

const userPath = (userId: string) => `/api/admin/users/${encodeURIComponent(userId)}`;

/** After any change: the lists (filters, counts) and that account's detail. */
const refreshUsers = () => queryClient.invalidateQueries({ queryKey: USERS_KEY });

export async function banUser(userId: string, reason: string): Promise<void> {
  const trimmed = reason.trim();
  await apiSend('POST', `${userPath(userId)}/ban`, trimmed ? { reason: trimmed } : {});
  await refreshUsers();
}

export async function unbanUser(userId: string): Promise<void> {
  await apiSend('POST', `${userPath(userId)}/unban`);
  await refreshUsers();
}

export async function revokeUserSessions(userId: string): Promise<number> {
  const { revoked } = await apiSend<{ revoked: number }>(
    'POST',
    `${userPath(userId)}/sessions/revoke`,
  );
  await refreshUsers();
  return revoked;
}

export async function revokeUserDevices(userId: string): Promise<number> {
  const { revoked } = await apiSend<{ revoked: number }>(
    'POST',
    `${userPath(userId)}/devices/revoke`,
  );
  await refreshUsers();
  return revoked;
}

/** What happens to a deleted account's chat messages (docs/PROTOCOL.md 7.6). */
export type DeletedMessages = 'delete' | 'anonymize';
export const DELETED_MESSAGES: readonly DeletedMessages[] = ['delete', 'anonymize'];

/**
 * DELETE /api/admin/users/:userId { ban, messages }: deletes the account and its personal data;
 * its chat messages are deleted or kept as "account removed".
 */
export async function deleteUser(
  userId: string,
  ban: boolean,
  messages: DeletedMessages = 'delete',
): Promise<void> {
  await apiSend('DELETE', userPath(userId), { ban, messages });
  queryClient.removeQueries({ queryKey: userQuery(userId).queryKey });
  await refreshUsers();
}

/** POST /api/admin/claim: the install code makes the caller the platform admin. */
export async function claimAdmin(code: string): Promise<void> {
  await apiSend('POST', '/api/admin/claim', { code });
  await queryClient.invalidateQueries({ queryKey: ME_KEY, exact: true });
}
