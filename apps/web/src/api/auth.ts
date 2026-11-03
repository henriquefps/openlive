// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';
import * as client from '@openlive/client';
import type { AvatarState, Me, User } from '@openlive/client';
import { apiSend, webApi } from './client.ts';
import { queryClient } from './query-client.ts';

// The signed-in user and their sessions, as React Query queries over the shared calls
// (@openlive/client, api/auth.ts). The session lives in an HttpOnly cookie the page cannot read;
// GET /api/me is how the web learns who is signed in.

export type {
  AvatarState,
  Me,
  Membership,
  QuotaCodes,
  Session,
  User,
  ViewerBrakes,
} from '@openlive/client';
export { DISPLAY_NAME_MAX } from '@openlive/client';

export const ME_KEY = ['me'] as const;

/** The caller, or null when nobody is signed in (401). */
export const meQuery = queryOptions({
  queryKey: ME_KEY,
  queryFn: (): Promise<Me | null> => client.getMe(webApi),
  retry: false,
  staleTime: 60_000,
});

export const sessionsQuery = queryOptions({
  queryKey: ['me', 'sessions'],
  queryFn: () => client.listSessions(webApi),
});

/**
 * What a login brings to justify a new account on an invite-only instance: the invite token or
 * the quick room code of the page that sent the visitor to sign in.
 */
export interface SignupContext {
  invite?: string;
  code?: string;
}

/**
 * The invite or room code in a return path (`/invite/:token`, `/join/:code`), if any. The mobile
 * app's `/app/authorize?…&invite=<token>` carries its invite the same way (PROTOCOL 11.6).
 */
export function signupContextOf(returnTo: string | undefined): SignupContext {
  const path = returnTo?.split(/[?#]/)[0] ?? '';
  if (path === '/app/authorize') {
    const query = new URLSearchParams(/\?([^#]*)/.exec(returnTo ?? '')?.[1] ?? '');
    const token = query.get('invite');
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? { invite: token } : {};
  }
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
  queryFn: () => webApi.get<{ signup: 'invite_only' | 'open' }>('/api/auth/policy'),
  staleTime: 5 * 60_000,
});

export async function logout(): Promise<void> {
  await client.logout(webApi);
  queryClient.setQueryData(ME_KEY, null);
  queryClient.removeQueries({ queryKey: ['me', 'sessions'] });
}

export function revokeSession(sessionId: string): Promise<void> {
  return client.revokeSession(webApi, sessionId);
}

export async function updateMe(input: {
  displayName?: string;
  locale?: string | null;
}): Promise<User> {
  const user = await client.updateMe(webApi, input);
  queryClient.setQueryData<Me | null>(ME_KEY, (me) => (me ? { ...me, user } : me));
  if (input.displayName !== undefined) await profileChanged();
  return user;
}

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
export const uploadAvatar = (photo: Blob) => applyProfile(client.uploadAvatar(webApi, photo));

/** DELETE /api/me/avatar: back to initials. */
export const removeAvatar = () => applyProfile(client.removeAvatar(webApi));

/** POST /api/me/avatar/discord: back to the Discord photo. */
export const restoreDiscordAvatar = () => applyProfile(client.restoreDiscordAvatar(webApi));
