// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';
import { ApiError, apiGet, apiSend, apiUpload } from './client.ts';
import { queryClient } from './query-client.ts';

// The signed-in user and their sessions. The session lives in an HttpOnly cookie the
// page cannot read; GET /api/me is how the web learns who is signed in.

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

export const ME_KEY = ['me'] as const;

/** The caller, or null when nobody is signed in (401). */
export const meQuery = queryOptions({
  queryKey: ME_KEY,
  queryFn: async (): Promise<Me | null> => {
    try {
      return await apiGet<Me>('/api/me');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
  retry: false,
  staleTime: 60_000,
});

export const sessionsQuery = queryOptions({
  queryKey: ['me', 'sessions'],
  queryFn: () => apiGet<{ sessions: Session[] }>('/api/me/sessions'),
});

/**
 * What a login brings to justify a new account on an invite-only instance: the invite token or
 * the quick room code of the page that sent the visitor to sign in.
 */
export interface SignupContext {
  invite?: string;
  code?: string;
}

/** The invite or room code in a return path (`/invite/:token`, `/join/:code`), if any. */
export function signupContextOf(returnTo: string | undefined): SignupContext {
  const path = returnTo?.split(/[?#]/)[0] ?? '';
  const invite = /^\/invite\/([A-Za-z0-9_-]{43})$/.exec(path)?.[1];
  if (invite) return { invite };
  const code = /^\/join\/([^/]{1,64})$/.exec(path)?.[1];
  return code ? { code: decodeURIComponent(code) } : {};
}

/** Where the Discord button sends the browser; the API redirects on to Discord. */
export function discordStartUrl(returnTo?: string, context: SignupContext = {}): string {
  const query = new URLSearchParams();
  if (returnTo) query.set('returnTo', returnTo);
  if (context.invite) query.set('invite', context.invite);
  if (context.code) query.set('code', context.code);
  const search = query.toString();
  return `/api/auth/discord/start${search ? `?${search}` : ''}`;
}

export function startEmailLogin(
  input: { email?: string; link?: true; locale: string; returnTo?: string } & SignupContext,
): Promise<{ sent: true }> {
  return apiSend('POST', '/api/auth/email/start', input);
}

/**
 * GET /api/auth/policy: the sign-up policy in effect. `invite_only` means a new account needs an
 * invite link or a room code; existing accounts always sign in.
 */
export const signupPolicyQuery = queryOptions({
  queryKey: ['auth', 'policy'],
  queryFn: () => apiGet<{ signup: 'invite_only' | 'open' }>('/api/auth/policy'),
  staleTime: 5 * 60_000,
});

export async function logout(): Promise<void> {
  await apiSend('POST', '/api/auth/logout');
  queryClient.setQueryData(ME_KEY, null);
  queryClient.removeQueries({ queryKey: ['me', 'sessions'] });
}

export function revokeSession(sessionId: string): Promise<void> {
  return apiSend('DELETE', `/api/me/sessions/${encodeURIComponent(sessionId)}`);
}

export async function updateMe(input: {
  displayName?: string;
  locale?: string | null;
}): Promise<User> {
  const { user } = await apiSend<{ user: User }>('PUT', '/api/me', input);
  queryClient.setQueryData<Me | null>(ME_KEY, (me) => (me ? { ...me, user } : me));
  if (input.displayName !== undefined) await profileChanged();
  return user;
}

/** The same rule as the API's: trimmed, 1 to 80 characters. */
export const DISPLAY_NAME_MAX = 80;

/**
 * After a new name or photo: the lists that carry the caller's name and avatarUrl are fetched
 * again (space members and join requests, the admin's user list). Rooms already open keep the
 * old ones until the room socket reconnects, which carries them (docs/PROTOCOL.md 11.5).
 */
async function profileChanged(): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['space'] }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  ]);
}

async function applyProfile(result: Promise<{ user: User; avatar: AvatarState }>): Promise<User> {
  const { user, avatar } = await result;
  queryClient.setQueryData<Me | null>(ME_KEY, (me) => (me ? { ...me, user, avatar } : me));
  await profileChanged();
  return user;
}

/** PUT /api/me/avatar: the photo made by lib/avatar-image.ts. */
export const uploadAvatar = (photo: Blob) =>
  applyProfile(apiUpload('PUT', '/api/me/avatar', photo));

/** DELETE /api/me/avatar: back to initials. */
export const removeAvatar = () => applyProfile(apiSend('DELETE', '/api/me/avatar'));

/** POST /api/me/avatar/discord: back to the Discord photo. */
export const restoreDiscordAvatar = () => applyProfile(apiSend('POST', '/api/me/avatar/discord'));
