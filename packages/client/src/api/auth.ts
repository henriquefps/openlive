// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, type ApiClient } from './client.ts';

// The signed-in user and their sessions. On the web the session lives in an HttpOnly
// cookie the page cannot read; GET /api/me is how a client learns who is signed in.

export interface User {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  locale: string | null;
  isPlatformAdmin: boolean;
}

export interface Membership {
  spaceId: string;
  name: string;
  slug: string;
  role: string;
  /** The platform admin suspended the space. */
  suspended?: boolean;
}

/** The instance's quota brake state: codes only, the numbers are for the admin. */
export interface QuotaCodes {
  /** Relative to the monthly limit; always 'ok' when unlimited. */
  level: 'ok' | 'warn_70' | 'warn_90' | 'warn_100';
  /** The monthly limit in GB (a setting, not usage); null when unlimited. */
  limitGB: number | null;
  mode: 'block' | 'alerts_only';
  /** Usage is past the free tier, so Cloudflare bills it. */
  freeTierExceeded: boolean;
  economyMode: boolean;
  blockNewStreams: boolean;
  /** The cost so far above the free tier: only for the platform admin. */
  costUsd?: number;
}

/** Where the profile photo comes from (Settings -> Profile). */
export interface AvatarState {
  /** `discord` also means "no photo yet" while `avatarUrl` is null. */
  source: 'discord' | 'upload' | 'none';
  /** The account has a Discord photo to go back to. */
  discordAvailable: boolean;
}

export interface Me {
  user: User;
  avatar?: AvatarState;
  memberships: Membership[];
  /** No platform admin yet: a signed-in user may claim the instance with the install code. */
  adminClaimable?: boolean;
  /** Whether "Create space" works for the caller (platform setting `spaceCreation`). */
  canCreateSpace?: boolean;
  quota?: QuotaCodes;
  /** The viewer brakes 5 and 6, on by default. */
  viewerBrakes?: ViewerBrakes;
}

/** Whether the player pauses a hidden tab's video and asks "Still watching?". */
export interface ViewerBrakes {
  backgroundPause: boolean;
  idleCheck: boolean;
}

/** A signed-in browser, or the mobile app on one device (its app token). */
export type Session =
  | {
      id: string;
      kind: 'browser';
      createdAt: number;
      expiresAt: number;
      userAgent: string | null;
      current: boolean;
    }
  | {
      id: string;
      kind: 'app';
      createdAt: number;
      deviceName: string;
      lastUsedAt: number | null;
      current: boolean;
    };

/** The same rule as the API's: trimmed, 1 to 80 characters. */
export const DISPLAY_NAME_MAX = 80;

/** The caller, or null when nobody is signed in (401). */
export async function getMe(api: ApiClient): Promise<Me | null> {
  try {
    return await api.get<Me>('/api/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export const listSessions = (api: ApiClient) =>
  api.get<{ sessions: Session[] }>('/api/me/sessions');

export function revokeSession(api: ApiClient, sessionId: string): Promise<void> {
  return api.send('DELETE', `/api/me/sessions/${encodeURIComponent(sessionId)}`);
}

export async function logout(api: ApiClient): Promise<void> {
  await api.send('POST', '/api/auth/logout');
}

export async function updateMe(
  api: ApiClient,
  input: { displayName?: string; locale?: string | null },
): Promise<User> {
  return (await api.send<{ user: User }>('PUT', '/api/me', input)).user;
}

export interface ProfileResult {
  user: User;
  avatar: AvatarState;
}

/** PUT /api/me/avatar: a square photo (the web makes it in lib/avatar-image.ts). */
export const uploadAvatar = (api: ApiClient, photo: Blob) =>
  api.upload<ProfileResult>('PUT', '/api/me/avatar', photo);

/** DELETE /api/me/avatar: back to initials. */
export const removeAvatar = (api: ApiClient) => api.send<ProfileResult>('DELETE', '/api/me/avatar');

/** POST /api/me/avatar/discord: back to the Discord photo. */
export const restoreDiscordAvatar = (api: ApiClient) =>
  api.send<ProfileResult>('POST', '/api/me/avatar/discord');
