// SPDX-License-Identifier: AGPL-3.0-only
import type { QueryKey } from '@tanstack/react-query';
import { keys, type Scope } from './cache.ts';

// What each space mutation makes stale (the web's useInvalidating lists in api/spaces.ts), as
// pure functions of the cache keys so they are tested. The caller's profile (`me`) holds no
// memberships on the phone, so it is never among them.

export type SpaceMutation =
  | 'updateSpace'
  | 'transferSpace'
  | 'changeRole'
  | 'setBanned'
  | 'removeMember'
  | 'createRoom'
  | 'createInvite'
  | 'revokeInvite'
  | 'decideJoinRequest';

export function staleAfter(
  scope: Scope,
  spaceId: string,
  mutation: SpaceMutation,
): readonly QueryKey[] {
  const k = keys(scope);
  switch (mutation) {
    case 'updateSpace':
      return [k.space(spaceId), k.rooms(spaceId), k.spaces()];
    case 'transferSpace':
      return [k.space(spaceId), k.members(spaceId), k.spaces()];
    case 'changeRole':
    case 'setBanned':
      return [k.members(spaceId)];
    case 'removeMember':
      return [k.members(spaceId), k.spaces()];
    case 'createRoom':
      return [k.rooms(spaceId)];
    case 'createInvite':
    case 'revokeInvite':
      return [k.invites(spaceId)];
    case 'decideJoinRequest':
      return [k.joinRequests(spaceId), k.members(spaceId)];
  }
}

/** Leaving or deleting a space only changes the list of spaces; the space's own entries go. */
export const staleAfterLeaving = (scope: Scope): readonly QueryKey[] => [keys(scope).spaces()];

/** Every cached entry of one space, to drop once it is gone (deleted, or left). */
export function spaceEntries(scope: Scope, spaceId: string): readonly QueryKey[] {
  const k = keys(scope);
  return [
    k.space(spaceId),
    k.members(spaceId),
    k.rooms(spaceId),
    k.unread(spaceId),
    k.invites(spaceId),
    k.joinRequests(spaceId),
    ['ol', scope.origin, scope.userId, 'status', spaceId],
  ];
}
