// SPDX-License-Identifier: AGPL-3.0-only
import type { Role } from '@openlive/protocol';
import type { Member, Room, Space } from './spaces.ts';

// What the UI offers each role (the role matrix), mirroring apps/api/src/auth/can.ts. This
// only hides or disables actions; the API decides, and its refusals are shown as errors.

export const isManager = (role: Role | null | undefined): boolean =>
  role === 'owner' || role === 'admin';

export interface SpaceAbilities {
  createFixedRoom: boolean;
  createQuickRoom: boolean;
  inviteMembers: boolean;
  inviteGuests: boolean;
  /** List invites (managers see all of them, members their own). */
  viewInvites: boolean;
  decideJoinRequests: boolean;
  /** The space status page. */
  viewStatus: boolean;
  updateSettings: boolean;
  deleteSpace: boolean;
  transfer: boolean;
}

export function spaceAbilities(space: Pick<Space, 'role' | 'settings'>): SpaceAbilities {
  const { role } = space;
  const manager = isManager(role);
  const member = manager || role === 'member';
  return {
    createFixedRoom: manager,
    createQuickRoom: member,
    inviteMembers: manager,
    inviteGuests: manager || (role === 'member' && space.settings.membersCanInviteGuests !== false),
    viewInvites: member,
    decideJoinRequests: manager,
    viewStatus: manager,
    updateSettings: manager,
    deleteSpace: role === 'owner',
    transfer: role === 'owner',
  };
}

/** Owners act on anyone but themselves; admins only on members and guests. */
export function canActOn(
  role: Role | null | undefined,
  selfId: string,
  target: Pick<Member, 'userId' | 'role'>,
): boolean {
  if (target.userId === selfId) return false;
  if (role === 'owner') return true;
  return role === 'admin' && !isManager(target.role);
}

/** The roles `role` may give someone (ownership moves only by transfer). */
export function assignableRoles(role: Role | null | undefined): ('admin' | 'member' | 'guest')[] {
  if (role === 'owner') return ['admin', 'member', 'guest'];
  if (role === 'admin') return ['member', 'guest'];
  return [];
}

/** Edit, archive and manage access: managers, or the member who opened a quick room. */
export function canManageRoom(
  role: Role | null | undefined,
  selfId: string,
  room: Pick<Room, 'kind' | 'createdBy'>,
): boolean {
  if (isManager(role)) return true;
  return room.kind === 'quick' && role === 'member' && room.createdBy === selfId;
}
