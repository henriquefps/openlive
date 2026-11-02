// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  type Action,
  type Actor,
  type DenyCode,
  type ResourceByAction,
  type RoomGrant,
  type RoomRef,
  type SpaceRef,
  type SpaceRole,
  type Target,
  can,
} from '../src/auth/can';

// One row per cell of the role matrix (action x role), then rows for
// the guest rules, the platform admin, and the general rules.

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const ROLES: readonly SpaceRole[] = ['owner', 'admin', 'member', 'guest'];

const SPACE: SpaceRef = { id: 's1', settings: { membersCanInviteGuests: true } };

function actor(role: SpaceRole | null, extra: Partial<Actor> = {}): Actor {
  return {
    userId: role ? `${role}-1` : 'outsider',
    isPlatformAdmin: false,
    membership: role ? { spaceId: SPACE.id, role, bannedAt: null } : null,
    ...extra,
  };
}

function room(extra: Partial<RoomRef> = {}): RoomRef {
  return {
    id: 'r1',
    spaceId: SPACE.id,
    visibility: 'space',
    archivedAt: null,
    expiresAt: null,
    actorAccess: null,
    capabilities: { stream: true, voice: false, camera: false, text: false },
    ...extra,
  };
}

const NO_STREAM = { stream: false, voice: true, camera: false, text: true };

function grant(extra: Partial<RoomGrant> = {}): RoomGrant {
  return { canView: true, canStream: false, expiresAt: null, ...extra };
}

function target(role: SpaceRole, userId = `${role}-2`, invitedBy: string | null = null): Target {
  return { userId, role, invitedBy };
}

type Expected = true | DenyCode;

interface Row<A extends Action = Action> {
  name: string;
  /** Matrix cell this row covers, as `<matrix row>/<role>`. */
  cell?: string;
  actor: Actor;
  action: A;
  resource: ResourceByAction[A];
  expected: Expected;
}

function row<A extends Action>(r: Row<A>): Row {
  return r as unknown as Row;
}

// The 13 rows of the 6.4.4 matrix.
const MATRIX_ROWS = [
  'view',
  'stream',
  'quick_room',
  'fixed_room',
  'invite_guests',
  'invite_members',
  'guest_stream_permission',
  'end_stream_or_remove',
  'approve_join',
  'change_roles',
  'ban',
  'space_settings',
  'delete_or_transfer',
] as const;
type MatrixRow = (typeof MATRIX_ROWS)[number];

const cell = (r: MatrixRow, role: SpaceRole) => `${r}/${role}`;

// Shorthand for the matrix rows whose resource is just the space.
function spaceRow(r: MatrixRow, action: Action, allowed: readonly SpaceRole[]): Row[] {
  return ROLES.map((role) =>
    row({
      name: `${action} as ${role}`,
      cell: cell(r, role),
      actor: actor(role),
      action: action as 'space.delete',
      resource: { space: SPACE },
      expected: allowed.includes(role) ? true : 'insufficient_role',
    }),
  );
}

const matrix: Row[] = [
  // Watch rooms: everyone, guests only in rooms they can access.
  ...ROLES.map((role) =>
    row({
      name: `view a space-visible room as ${role}`,
      cell: cell('view', role),
      actor: actor(role),
      action: 'room.view',
      resource: { room: room() },
      expected: true,
    }),
  ),
  row({
    name: 'guest cannot view a restricted room without room_access',
    cell: cell('view', 'guest'),
    actor: actor('guest'),
    action: 'room.view',
    resource: { room: room({ visibility: 'restricted' }) },
    expected: 'room_access_required',
  }),
  row({
    name: 'guest views a restricted room with room_access',
    cell: cell('view', 'guest'),
    actor: actor('guest'),
    action: 'room.view',
    resource: { room: room({ visibility: 'restricted', actorAccess: grant() }) },
    expected: true,
  }),

  // Stream: everyone but guests (until granted, see 6.4.5 rows).
  ...ROLES.map((role) =>
    row({
      name: `publish as ${role}`,
      cell: cell('stream', role),
      actor: actor(role),
      action: 'stream.publish',
      resource: { room: room() },
      expected: role === 'guest' ? 'stream_permission_required' : true,
    }),
  ),

  ...spaceRow('quick_room', 'room.quick.create', ['owner', 'admin', 'member']),
  ...spaceRow('fixed_room', 'room.fixed.manage', ['owner', 'admin']),

  // Invite guests: owner, admin, member (configurable).
  ...ROLES.map((role) =>
    row({
      name: `invite a guest as ${role}`,
      cell: cell('invite_guests', role),
      actor: actor(role),
      action: 'invite.create',
      resource: { space: SPACE, role: 'guest', canStream: false, room: null },
      expected: role === 'guest' ? 'insufficient_role' : true,
    }),
  ),
  row({
    name: 'member cannot invite guests when the space disables it',
    cell: cell('invite_guests', 'member'),
    actor: actor('member'),
    action: 'invite.create',
    resource: {
      space: { ...SPACE, settings: { membersCanInviteGuests: false } },
      role: 'guest',
      canStream: false,
      room: null,
    },
    expected: 'member_guest_invites_disabled',
  }),

  // Invite members: owner, admin.
  ...ROLES.map((role) =>
    row({
      name: `invite a member as ${role}`,
      cell: cell('invite_members', role),
      actor: actor(role),
      action: 'invite.create',
      resource: { space: SPACE, role: 'member', canStream: false, room: null },
      expected: role === 'owner' || role === 'admin' ? true : 'insufficient_role',
    }),
  ),

  // Give or take a guest's stream permission: owner, admin, member only for their own invitees.
  ...ROLES.map((role) =>
    row({
      name: `grant stream to someone else's guest as ${role}`,
      cell: cell('guest_stream_permission', role),
      actor: actor(role),
      action: 'guest.stream.set',
      resource: {
        space: SPACE,
        room: room(),
        target: target('guest', 'guest-9', 'someone-else'),
        grant: true,
      },
      expected: { owner: true, admin: true, member: 'not_inviter', guest: 'insufficient_role' }[
        role
      ] as Expected,
    }),
  ),
  ...[true, false].map((g) =>
    row({
      name: `member ${g ? 'grants' : 'revokes'} stream for a guest they invited`,
      cell: cell('guest_stream_permission', 'member'),
      actor: actor('member'),
      action: 'guest.stream.set',
      resource: {
        space: SPACE,
        room: room(),
        target: target('guest', 'guest-9', 'member-1'),
        grant: g,
      },
      expected: true,
    }),
  ),

  // End a stream or remove someone: owner, admin; member and guest only their own.
  ...ROLES.map((role) =>
    row({
      name: `end a member's stream as ${role}`,
      cell: cell('end_stream_or_remove', role),
      actor: actor(role),
      action: 'stream.end',
      resource: { room: room(), streamer: target('member', 'member-9') },
      expected: role === 'owner' || role === 'admin' ? true : 'insufficient_role',
    }),
  ),
  ...ROLES.map((role) =>
    row({
      name: `end own stream as ${role}`,
      cell: cell('end_stream_or_remove', role),
      actor: actor(role),
      action: 'stream.end',
      resource: { room: room(), streamer: target(role, `${role}-1`) },
      expected: true,
    }),
  ),
  ...ROLES.map((role) =>
    row({
      name: `remove a guest from the room as ${role}`,
      cell: cell('end_stream_or_remove', role),
      actor: actor(role),
      action: 'room.participant.remove',
      resource: { room: room(), target: target('guest', 'guest-9') },
      expected: role === 'owner' || role === 'admin' ? true : 'insufficient_role',
    }),
  ),

  ...spaceRow('approve_join', 'join_request.decide', ['owner', 'admin']),

  // Change roles: owner; admin up to member.
  ...ROLES.map((role) =>
    row({
      name: `promote a guest to member as ${role}`,
      cell: cell('change_roles', role),
      actor: actor(role),
      action: 'member.role.change',
      resource: { space: SPACE, target: target('guest'), newRole: 'member' },
      expected: role === 'owner' || role === 'admin' ? true : 'insufficient_role',
    }),
  ),
  row({
    name: 'owner promotes a member to admin',
    cell: cell('change_roles', 'owner'),
    actor: actor('owner'),
    action: 'member.role.change',
    resource: { space: SPACE, target: target('member'), newRole: 'admin' },
    expected: true,
  }),
  row({
    name: 'admin cannot promote to admin',
    cell: cell('change_roles', 'admin'),
    actor: actor('admin'),
    action: 'member.role.change',
    resource: { space: SPACE, target: target('member'), newRole: 'admin' },
    expected: 'grant_exceeds_own_permission',
  }),
  row({
    name: 'admin demotes a member to guest',
    cell: cell('change_roles', 'admin'),
    actor: actor('admin'),
    action: 'member.role.change',
    resource: { space: SPACE, target: target('member'), newRole: 'guest' },
    expected: true,
  }),

  // Ban: owner; admin except owner and admins.
  ...ROLES.map((role) =>
    row({
      name: `ban a member as ${role}`,
      cell: cell('ban', role),
      actor: actor(role),
      action: 'member.ban',
      resource: { space: SPACE, target: target('member') },
      expected: role === 'owner' || role === 'admin' ? true : 'insufficient_role',
    }),
  ),
  row({
    name: 'owner bans an admin',
    cell: cell('ban', 'owner'),
    actor: actor('owner'),
    action: 'member.ban',
    resource: { space: SPACE, target: target('admin') },
    expected: true,
  }),
  ...(['owner', 'admin'] as const).map((t) =>
    row({
      name: `admin cannot ban the ${t}`,
      cell: cell('ban', 'admin'),
      actor: actor('admin'),
      action: 'member.ban',
      resource: { space: SPACE, target: target(t) },
      expected: 'cannot_act_on_target',
    }),
  ),

  ...spaceRow('space_settings', 'space.settings.update', ['owner', 'admin']),
  ...spaceRow('delete_or_transfer', 'space.delete', ['owner']),
  ...ROLES.map((role) =>
    row({
      name: `transfer ownership as ${role}`,
      cell: cell('delete_or_transfer', role),
      actor: actor(role),
      action: 'space.transfer',
      resource: { space: SPACE, target: target('admin') },
      expected: role === 'owner' ? true : 'insufficient_role',
    }),
  ),
];

// Guests and the stream permission.
const guestRules: Row[] = [
  row({
    name: 'guest with room_access.can_stream may publish',
    actor: actor('guest'),
    action: 'stream.publish',
    resource: { room: room({ actorAccess: grant({ canStream: true }) }) },
    expected: true,
  }),
  row({
    name: 'guest stream permission with a future expiry still works',
    actor: actor('guest'),
    action: 'stream.publish',
    resource: { room: room({ actorAccess: grant({ canStream: true, expiresAt: NOW + HOUR }) }) },
    expected: true,
  }),
  row({
    name: 'expired guest stream permission no longer allows publishing',
    actor: actor('guest'),
    action: 'stream.publish',
    resource: { room: room({ actorAccess: grant({ canStream: true, expiresAt: NOW }) }) },
    expected: 'stream_permission_required',
  }),
  row({
    name: 'expired room_access no longer opens a restricted room',
    actor: actor('member'),
    action: 'room.view',
    resource: {
      room: room({ visibility: 'restricted', actorAccess: grant({ expiresAt: NOW - 1 }) }),
    },
    expected: 'room_access_required',
  }),
  row({
    name: 'room-only guest (no space membership) views the room they were invited to',
    actor: actor(null),
    action: 'room.view',
    resource: { room: room({ actorAccess: grant() }) },
    expected: true,
  }),
  row({
    name: 'room-only guest needs can_stream to publish',
    actor: actor(null),
    action: 'stream.publish',
    resource: { room: room({ actorAccess: grant() }) },
    expected: 'stream_permission_required',
  }),
  row({
    name: 'room-only guest with can_stream may publish',
    actor: actor(null),
    action: 'stream.publish',
    resource: { room: room({ actorAccess: grant({ canStream: true }) }) },
    expected: true,
  }),
  row({
    name: 'room-only guest sees nothing else in the space',
    actor: actor(null),
    action: 'room.quick.create',
    resource: { space: SPACE },
    expected: 'not_space_member',
  }),
  row({
    name: 'stream permission is only for guests (members get it from their role)',
    actor: actor('admin'),
    action: 'guest.stream.set',
    resource: { space: SPACE, room: room(), target: target('member'), grant: true },
    expected: 'target_not_guest',
  }),
  row({
    name: 'after the inviter leaves, admins manage the grant',
    actor: actor('admin'),
    action: 'guest.stream.set',
    resource: {
      space: SPACE,
      room: room(),
      target: target('guest', 'guest-9', 'departed-user'),
      grant: false,
    },
    expected: true,
  }),
  row({
    name: 'an inviter who left the space can no longer manage the grant',
    actor: { ...actor('member'), membership: null },
    action: 'guest.stream.set',
    resource: {
      space: SPACE,
      room: room(),
      target: target('guest', 'guest-9', 'member-1'),
      grant: false,
    },
    expected: 'not_space_member',
  }),
  row({
    name: 'member cannot grant stream in a room they cannot stream in',
    actor: actor('member'),
    action: 'guest.stream.set',
    resource: {
      space: SPACE,
      room: room({ visibility: 'restricted' }),
      target: target('guest', 'guest-9', 'member-1'),
      grant: true,
    },
    expected: 'grant_exceeds_own_permission',
  }),
  row({
    name: 'member may revoke a grant they could not give',
    actor: actor('member'),
    action: 'guest.stream.set',
    resource: {
      space: SPACE,
      room: room({ visibility: 'restricted' }),
      target: target('guest', 'guest-9', 'member-1'),
      grant: false,
    },
    expected: true,
  }),
  row({
    name: 'invite with can_stream to a room the inviter can stream in',
    actor: actor('member'),
    action: 'invite.create',
    resource: { space: SPACE, role: 'guest', canStream: true, room: room() },
    expected: true,
  }),
  row({
    name: 'invite to a restricted room the inviter cannot see',
    actor: actor('member'),
    action: 'invite.create',
    resource: {
      space: SPACE,
      role: 'guest',
      canStream: true,
      room: room({ visibility: 'restricted' }),
    },
    expected: 'room_access_required',
  }),
  row({
    name: 'invite with can_stream to a closed room',
    actor: actor('owner'),
    action: 'invite.create',
    resource: { space: SPACE, role: 'guest', canStream: true, room: room({ archivedAt: NOW - 1 }) },
    expected: 'room_closed',
  }),
];

// The platform admin operates the instance but has no space role.
const platformRules: Row[] = [
  ...(['platform.usage.view', 'platform.settings.update'] as const).flatMap((action) => [
    row({
      name: `${action} as platform admin`,
      actor: actor(null, { isPlatformAdmin: true }),
      action,
      resource: {},
      expected: true,
    }),
    row({
      name: `${action} as a space owner`,
      actor: actor('owner'),
      action,
      resource: {},
      expected: 'platform_admin_required',
    }),
  ]),
  ...(['platform.user.view', 'platform.user.ban', 'platform.user.delete'] as const).flatMap(
    (action) => [
      row({
        name: `${action} as platform admin`,
        actor: actor(null, { isPlatformAdmin: true }),
        action,
        resource: {},
        expected: true,
      }),
      row({
        name: `${action} as a space owner`,
        actor: actor('owner'),
        action,
        resource: {},
        expected: 'platform_admin_required',
      }),
    ],
  ),
  // Space creation: the platform admin always; everyone else only under the `members` policy.
  ...(['admin_only', 'members'] as const).flatMap((policy) => [
    row({
      name: `space.create (${policy}) as platform admin`,
      actor: actor(null, { isPlatformAdmin: true }),
      action: 'space.create',
      resource: { policy },
      expected: true,
    }),
    ...([...ROLES, null] as const).map((role) =>
      row({
        name: `space.create (${policy}) as ${role ?? 'someone in no space'}`,
        actor: actor(role),
        action: 'space.create',
        resource: { policy },
        expected: policy === 'members' ? true : ('platform_admin_required' as const),
      }),
    ),
  ]),
  // The helper download: the platform admin, or a member of any space.
  ...([true, false] as const).flatMap((memberOfAnySpace) => [
    row({
      name: `helper.download as platform admin (member of a space: ${memberOfAnySpace})`,
      actor: actor(null, { isPlatformAdmin: true }),
      action: 'helper.download',
      resource: { memberOfAnySpace },
      expected: true,
    }),
    row({
      name: `helper.download as a user (member of a space: ${memberOfAnySpace})`,
      actor: actor(null),
      action: 'helper.download',
      resource: { memberOfAnySpace },
      expected: memberOfAnySpace ? true : ('not_space_member' as const),
    }),
  ]),
  // Profile photos: oneself, the platform admin, or someone who shares a space.
  ...([true, false] as const).flatMap((sharesSpace) => [
    row({
      name: `user.avatar.view of someone else (shares a space: ${sharesSpace})`,
      actor: actor(null),
      action: 'user.avatar.view',
      resource: { userId: 'u_other', sharesSpace },
      expected: sharesSpace ? true : ('not_space_member' as const),
    }),
    row({
      name: `user.avatar.view as platform admin (shares a space: ${sharesSpace})`,
      actor: actor(null, { isPlatformAdmin: true }),
      action: 'user.avatar.view',
      resource: { userId: 'u_other', sharesSpace },
      expected: true,
    }),
  ]),
  row({
    name: 'user.avatar.view of oneself',
    actor: actor(null),
    action: 'user.avatar.view',
    resource: { userId: 'outsider', sharesSpace: false },
    expected: true,
  }),
  row({
    name: 'platform admin suspends a space',
    actor: actor(null, { isPlatformAdmin: true }),
    action: 'platform.space.suspend',
    resource: { space: SPACE },
    expected: true,
  }),
  row({
    name: 'space owner cannot suspend a space',
    actor: actor('owner'),
    action: 'platform.space.suspend',
    resource: { space: SPACE },
    expected: 'platform_admin_required',
  }),
  row({
    name: 'platform admin does not see rooms of a space they are not in',
    actor: actor(null, { isPlatformAdmin: true }),
    action: 'room.view',
    resource: { room: room() },
    expected: 'not_space_member',
  }),
  row({
    name: 'platform admin does not manage a space they are not in',
    actor: actor(null, { isPlatformAdmin: true }),
    action: 'space.settings.update',
    resource: { space: SPACE },
    expected: 'not_space_member',
  }),
];

// General rules from 6.4.4 and the room rules.
const generalRules: Row[] = [
  ...(['stream.end', 'room.participant.remove'] as const).flatMap((action) =>
    (['owner', 'admin'] as const).map((t) =>
      row({
        name: `admin cannot ${action} on the ${t}`,
        actor: actor('admin'),
        action,
        resource:
          action === 'stream.end'
            ? { room: room(), streamer: target(t) }
            : { room: room(), target: target(t) },
        expected: 'cannot_act_on_target',
      }),
    ),
  ),
  row({
    name: "admin cannot change another admin's role",
    actor: actor('admin'),
    action: 'member.role.change',
    resource: { space: SPACE, target: target('admin'), newRole: 'member' },
    expected: 'cannot_act_on_target',
  }),
  row({
    name: 'admin cannot demote the owner',
    actor: actor('admin'),
    action: 'member.role.change',
    resource: { space: SPACE, target: target('owner', 'owner-1'), newRole: 'member' },
    expected: 'cannot_act_on_target',
  }),
  row({
    name: 'ownership moves only through transfer',
    actor: actor('owner'),
    action: 'member.role.change',
    resource: { space: SPACE, target: target('admin'), newRole: 'owner' },
    expected: 'invalid_role',
  }),
  row({
    name: 'owner cannot change their own role',
    actor: actor('owner'),
    action: 'member.role.change',
    resource: { space: SPACE, target: target('owner', 'owner-1'), newRole: 'member' },
    expected: 'cannot_act_on_self',
  }),
  row({
    name: 'owner cannot ban themselves',
    actor: actor('owner'),
    action: 'member.ban',
    resource: { space: SPACE, target: target('owner', 'owner-1') },
    expected: 'cannot_act_on_self',
  }),
  row({
    name: 'ownership cannot go to a guest',
    actor: actor('owner'),
    action: 'space.transfer',
    resource: { space: SPACE, target: target('guest') },
    expected: 'invalid_role',
  }),
  row({
    name: 'members leave a room themselves',
    actor: actor('member'),
    action: 'room.participant.remove',
    resource: { room: room(), target: target('member', 'member-1') },
    expected: true,
  }),
  row({
    name: 'owner bypasses room restrictions',
    actor: actor('owner'),
    action: 'room.view',
    resource: { room: room({ visibility: 'restricted' }) },
    expected: true,
  }),
  row({
    name: 'admin bypasses room restrictions',
    actor: actor('admin'),
    action: 'stream.publish',
    resource: { room: room({ visibility: 'restricted' }) },
    expected: true,
  }),
  row({
    name: 'member cannot see a restricted room without room_access',
    actor: actor('member'),
    action: 'room.view',
    resource: { room: room({ visibility: 'restricted' }) },
    expected: 'room_access_required',
  }),
  row({
    name: 'member with room_access streams in a restricted room',
    actor: actor('member'),
    action: 'stream.publish',
    resource: { room: room({ visibility: 'restricted', actorAccess: grant() }) },
    expected: true,
  }),
  row({
    name: 'banned member is locked out even with room_access',
    actor: {
      ...actor('member'),
      membership: { spaceId: SPACE.id, role: 'member', bannedAt: NOW - 1 },
    },
    action: 'room.view',
    resource: { room: room({ actorAccess: grant({ canStream: true }) }) },
    expected: 'banned',
  }),
  row({
    name: 'membership in another space does not count',
    actor: { ...actor('owner'), membership: { spaceId: 'other', role: 'owner', bannedAt: null } },
    action: 'room.fixed.manage',
    resource: { space: SPACE },
    expected: 'not_space_member',
  }),
  row({
    name: 'expired quick room is closed',
    actor: actor('owner'),
    action: 'stream.publish',
    resource: { room: room({ expiresAt: NOW }) },
    expected: 'room_closed',
  }),
  row({
    name: 'archived room is closed',
    actor: actor('member'),
    action: 'room.view',
    resource: { room: room({ archivedAt: NOW - HOUR }) },
    expected: 'room_closed',
  }),
  row({
    name: 'owner still invites guests when members cannot',
    actor: actor('owner'),
    action: 'invite.create',
    resource: {
      space: { ...SPACE, settings: { membersCanInviteGuests: false } },
      role: 'guest',
      canStream: false,
      room: null,
    },
    expected: true,
  }),
];

// Actions the REST routes need beyond the matrix rows (space reads, quick room and invite upkeep).
const restRules: Row[] = [
  // The space status page: the space's managers and the platform admin.
  ...ROLES.map((role) =>
    row({
      name: `${role} ${role === 'owner' || role === 'admin' ? 'sees' : 'does not see'} the space status`,
      actor: actor(role),
      action: 'space.status.view',
      resource: { space: SPACE },
      expected: role === 'owner' || role === 'admin' ? true : 'insufficient_role',
    }),
  ),
  row({
    name: 'platform admin sees any space status',
    actor: actor(null, { isPlatformAdmin: true }),
    action: 'space.status.view',
    resource: { space: SPACE },
    expected: true,
  }),
  row({
    name: 'outsider does not see the space status',
    actor: actor(null),
    action: 'space.status.view',
    resource: { space: SPACE },
    expected: 'not_space_member',
  }),
  ...ROLES.map((role) =>
    row({
      name: `${role} sees the space`,
      actor: actor(role),
      action: 'space.view',
      resource: { space: SPACE },
      expected: true,
    }),
  ),
  row({
    name: 'outsider does not see the space',
    actor: actor(null),
    action: 'space.view',
    resource: { space: SPACE },
    expected: 'not_space_member',
  }),
  row({
    name: 'banned member does not see the space',
    actor: { ...actor('member'), membership: { spaceId: SPACE.id, role: 'member', bannedAt: NOW } },
    action: 'space.view',
    resource: { space: SPACE },
    expected: 'banned',
  }),
  ...(['room.quick.manage', 'invite.manage'] as const).flatMap((action) => [
    row({
      name: `${action}: admin manages anyone's`,
      actor: actor('admin'),
      action,
      resource: { space: SPACE, createdBy: 'member-2' },
      expected: true,
    }),
    row({
      name: `${action}: member manages their own`,
      actor: actor('member'),
      action,
      resource: { space: SPACE, createdBy: 'member-1' },
      expected: true,
    }),
    row({
      name: `${action}: member does not manage someone else's`,
      actor: actor('member'),
      action,
      resource: { space: SPACE, createdBy: 'member-2' },
      expected: 'insufficient_role',
    }),
    row({
      name: `${action}: a creator demoted to guest no longer manages it`,
      actor: actor('guest'),
      action,
      resource: { space: SPACE, createdBy: 'guest-1' },
      expected: 'insufficient_role',
    }),
  ]),
];

// Room capabilities: stream actions need the stream capability;
// the permission to stream does not depend on it.
const capabilityRules: Row[] = [
  ...ROLES.flatMap((role) => [
    row({
      name: `${role} cannot publish in a room without stream`,
      actor: actor(role),
      action: 'stream.publish',
      resource: { room: room({ capabilities: NO_STREAM }) },
      // The capability comes first: nobody streams there, so the permission does not matter.
      expected: 'capability_disabled',
    }),
    row({
      name: `${role} watches streams in a room with stream`,
      actor: actor(role),
      action: 'stream.subscribe',
      resource: { room: room() },
      expected: true,
    }),
    row({
      name: `${role} cannot watch in a room without stream`,
      actor: actor(role),
      action: 'stream.subscribe',
      resource: { room: room({ capabilities: NO_STREAM }) },
      expected: 'capability_disabled',
    }),
    row({
      name: `${role} keeps the stream permission in a room without stream`,
      actor: actor(role),
      action: 'stream.permission',
      resource: { room: room({ capabilities: NO_STREAM }) },
      expected: role === 'guest' ? 'stream_permission_required' : true,
    }),
  ]),
  row({
    name: 'guest with the stream grant cannot publish in a room without stream',
    actor: actor('guest'),
    action: 'stream.publish',
    resource: { room: room({ capabilities: NO_STREAM, actorAccess: grant({ canStream: true }) }) },
    expected: 'capability_disabled',
  }),
  row({
    name: 'outsider learns nothing about a room without stream',
    actor: actor(null),
    action: 'stream.subscribe',
    resource: { room: room({ capabilities: NO_STREAM }) },
    expected: 'not_space_member',
  }),
  row({
    name: 'a closed room stays closed, whatever its capabilities',
    actor: actor('owner'),
    action: 'stream.publish',
    resource: { room: room({ capabilities: NO_STREAM, archivedAt: NOW - HOUR }) },
    expected: 'room_closed',
  }),
  row({
    name: 'member grants a guest the stream permission in a room without stream',
    actor: actor('member'),
    action: 'guest.stream.set',
    resource: {
      space: SPACE,
      room: room({ capabilities: NO_STREAM }),
      target: target('guest', 'guest-2', 'member-1'),
      grant: true,
    },
    expected: true,
  }),
  row({
    name: 'member invites a streaming guest to a room without stream',
    actor: actor('member'),
    action: 'invite.create',
    resource: {
      space: SPACE,
      role: 'guest',
      canStream: true,
      room: room({ capabilities: NO_STREAM }),
    },
    expected: true,
  }),
];

// Voice: one row per cell of its matrix (action x role), then the
// capability, the room setting and the targets of moderation.
const VOICE = { stream: true, voice: true, camera: false, text: true };
const NO_VOICE = { stream: true, voice: false, camera: false, text: true };
const voiceRoom = (extra: Partial<RoomRef> = {}) => room({ capabilities: VOICE, ...extra });
const VOICE_MATRIX_ROWS = ['join', 'speak', 'serverMute', 'kick'] as const;
const voiceCell = (r: (typeof VOICE_MATRIX_ROWS)[number], role: SpaceRole) => `voice.${r}/${role}`;

const voiceMatrix: Row[] = ROLES.flatMap((role) => [
  row({
    name: `${role} joins the voice channel and listens`,
    cell: voiceCell('join', role),
    actor: actor(role),
    action: 'voice.join',
    resource: { room: voiceRoom() },
    expected: true,
  }),
  row({
    name: `${role} speaks in the voice channel (default room settings)`,
    cell: voiceCell('speak', role),
    actor: actor(role),
    action: 'voice.speak',
    resource: { room: voiceRoom(), guestsCanSpeak: true },
    expected: true,
  }),
  row({
    name: `${role} server-mutes a member`,
    cell: voiceCell('serverMute', role),
    actor: actor(role),
    action: 'voice.serverMute',
    resource: { room: voiceRoom(), target: target('member') },
    expected: role === 'owner' || role === 'admin' ? true : 'insufficient_role',
  }),
  row({
    name: `${role} takes a guest out of the voice channel`,
    cell: voiceCell('kick', role),
    actor: actor(role),
    action: 'voice.kick',
    resource: { room: voiceRoom(), target: target('guest') },
    expected: role === 'owner' || role === 'admin' ? true : 'insufficient_role',
  }),
]);

const voiceRules: Row[] = [
  ...(['voice.join', 'voice.speak'] as const).flatMap((action) =>
    ROLES.map((role) =>
      row({
        name: `${role}: ${action} needs the voice capability`,
        actor: actor(role),
        action,
        resource: { room: room({ capabilities: NO_VOICE }), guestsCanSpeak: true },
        expected: 'capability_disabled',
      }),
    ),
  ),
  ...(['voice.serverMute', 'voice.kick'] as const).map((action) =>
    row({
      name: `owner: ${action} needs the voice capability`,
      actor: actor('owner'),
      action,
      resource: { room: room({ capabilities: NO_VOICE }), target: target('member') },
      expected: 'capability_disabled',
    }),
  ),
  ...ROLES.map((role) =>
    row({
      name: `${role} speaks where the room keeps guests silent: ${role === 'guest' ? 'no' : 'yes'}`,
      actor: actor(role),
      action: 'voice.speak',
      resource: { room: voiceRoom(), guestsCanSpeak: false },
      expected: role === 'guest' ? 'voice_speak_not_allowed' : true,
    }),
  ),
  row({
    name: 'room-only guest (room grant) joins and speaks',
    actor: actor(null),
    action: 'voice.speak',
    resource: { room: voiceRoom({ actorAccess: grant() }), guestsCanSpeak: true },
    expected: true,
  }),
  row({
    name: 'room-only guest is silent where guests may not speak',
    actor: actor(null),
    action: 'voice.speak',
    resource: { room: voiceRoom({ actorAccess: grant() }), guestsCanSpeak: false },
    expected: 'voice_speak_not_allowed',
  }),
  row({
    name: 'outsider cannot join the voice channel',
    actor: actor(null),
    action: 'voice.join',
    resource: { room: voiceRoom() },
    expected: 'not_space_member',
  }),
  row({
    name: 'banned member cannot join the voice channel',
    actor: actor('member', {
      membership: { spaceId: SPACE.id, role: 'member', bannedAt: NOW - HOUR },
    }),
    action: 'voice.join',
    resource: { room: voiceRoom() },
    expected: 'banned',
  }),
  row({
    name: 'member without access to a restricted room cannot join its voice',
    actor: actor('member'),
    action: 'voice.join',
    resource: { room: voiceRoom({ visibility: 'restricted' }) },
    expected: 'room_access_required',
  }),
  row({
    name: 'nobody joins the voice of a closed room',
    actor: actor('owner'),
    action: 'voice.join',
    resource: { room: voiceRoom({ archivedAt: NOW - HOUR }) },
    expected: 'room_closed',
  }),
  ...(['voice.serverMute', 'voice.kick'] as const).flatMap((action) => [
    row({
      name: `admin cannot ${action} the owner`,
      actor: actor('admin'),
      action,
      resource: { room: voiceRoom(), target: target('owner') },
      expected: 'cannot_act_on_target',
    }),
    row({
      name: `admin cannot ${action} another admin`,
      actor: actor('admin'),
      action,
      resource: { room: voiceRoom(), target: target('admin') },
      expected: 'cannot_act_on_target',
    }),
    row({
      name: `owner may ${action} an admin`,
      actor: actor('owner'),
      action,
      resource: { room: voiceRoom(), target: target('admin') },
      expected: true,
    }),
    row({
      name: `nobody may ${action} themselves`,
      actor: actor('owner'),
      action,
      resource: { room: voiceRoom(), target: target('owner', 'owner-1') },
      expected: 'cannot_act_on_self',
    }),
    row({
      name: `member cannot ${action} a guest`,
      actor: actor('member'),
      action,
      resource: { room: voiceRoom(), target: target('guest') },
      expected: 'insufficient_role',
    }),
  ]),
];

// Cameras: one row per cell of the camera matrix, then the
// capability (camera needs voice), the room's guestsCanUseCamera and moderation targets.
const CAMERA = { stream: true, voice: true, camera: true, text: true };
const cameraRoom = (extra: Partial<RoomRef> = {}) => room({ capabilities: CAMERA, ...extra });
const CAMERA_MATRIX_ROWS = ['publish', 'moderate'] as const;
const cameraCell = (r: (typeof CAMERA_MATRIX_ROWS)[number], role: SpaceRole) =>
  `camera.${r}/${role}`;

const cameraMatrix: Row[] = ROLES.flatMap((role) => [
  row({
    name: `${role} turns a camera on (default room settings: guests may not)`,
    cell: cameraCell('publish', role),
    actor: actor(role),
    action: 'camera.publish',
    resource: { room: cameraRoom(), guestsCanUseCamera: false },
    expected: role === 'guest' ? 'camera_not_allowed' : true,
  }),
  row({
    name: `${role} turns a member's camera off`,
    cell: cameraCell('moderate', role),
    actor: actor(role),
    action: 'camera.moderate',
    resource: { room: cameraRoom(), target: target('member') },
    expected: role === 'owner' || role === 'admin' ? true : 'insufficient_role',
  }),
]);

// Text chat: one row per cell of its matrix, then the capability,
// the room setting and the authors whose messages a moderator may delete.
const TEXT = { stream: true, voice: false, camera: false, text: true };
const NO_TEXT = { stream: true, voice: true, camera: false, text: false };
const textRoom = (extra: Partial<RoomRef> = {}) => room({ capabilities: TEXT, ...extra });
const CHAT_MATRIX_ROWS = ['read', 'write', 'deleteOthers'] as const;
const chatCell = (r: (typeof CHAT_MATRIX_ROWS)[number], role: SpaceRole) => `chat.${r}/${role}`;

const chatMatrix: Row[] = ROLES.flatMap((role) => [
  row({
    name: `${role} reads the chat`,
    cell: chatCell('read', role),
    actor: actor(role),
    action: 'chat.read',
    resource: { room: textRoom() },
    expected: true,
  }),
  row({
    name: `${role} writes in the chat (default room settings)`,
    cell: chatCell('write', role),
    actor: actor(role),
    action: 'chat.write',
    resource: { room: textRoom(), guestsCanWrite: true },
    expected: true,
  }),
  row({
    name: `${role} deletes a member's message`,
    cell: chatCell('deleteOthers', role),
    actor: actor(role),
    action: 'chat.delete',
    resource: { room: textRoom(), author: target('member') },
    expected: role === 'owner' || role === 'admin' ? true : 'insufficient_role',
  }),
]);

const cameraRules: Row[] = [
  ...ROLES.map((role) =>
    row({
      name: `${role} turns a camera on where the room lets guests: yes`,
      actor: actor(role),
      action: 'camera.publish',
      resource: { room: cameraRoom(), guestsCanUseCamera: true },
      expected: true,
    }),
  ),
  ...ROLES.map((role) =>
    row({
      name: `${role}: camera.publish needs the camera capability`,
      actor: actor(role),
      action: 'camera.publish',
      resource: { room: voiceRoom(), guestsCanUseCamera: true },
      expected: 'capability_disabled',
    }),
  ),
  row({
    name: 'owner: camera without voice is no camera',
    actor: actor('owner'),
    action: 'camera.publish',
    resource: {
      room: room({ capabilities: { stream: true, voice: false, camera: true, text: true } }),
      guestsCanUseCamera: true,
    },
    expected: 'capability_disabled',
  }),
  row({
    name: 'room-only guest (room grant) needs guestsCanUseCamera',
    actor: actor(null),
    action: 'camera.publish',
    resource: { room: cameraRoom({ actorAccess: grant() }), guestsCanUseCamera: false },
    expected: 'camera_not_allowed',
  }),
  row({
    name: 'outsider cannot turn a camera on',
    actor: actor(null),
    action: 'camera.publish',
    resource: { room: cameraRoom(), guestsCanUseCamera: true },
    expected: 'not_space_member',
  }),
  row({
    name: 'owner: camera.moderate needs the camera capability',
    actor: actor('owner'),
    action: 'camera.moderate',
    resource: { room: voiceRoom(), target: target('member') },
    expected: 'capability_disabled',
  }),
  row({
    name: "admin cannot turn another admin's camera off",
    actor: actor('admin'),
    action: 'camera.moderate',
    resource: { room: cameraRoom(), target: target('admin') },
    expected: 'cannot_act_on_target',
  }),
  row({
    name: "owner turns an admin's camera off",
    actor: actor('owner'),
    action: 'camera.moderate',
    resource: { room: cameraRoom(), target: target('admin') },
    expected: true,
  }),
  row({
    name: 'owner cannot target their own camera through moderation',
    actor: actor('owner'),
    action: 'camera.moderate',
    resource: { room: cameraRoom(), target: target('owner', 'owner-1') },
    expected: 'cannot_act_on_self',
  }),
];
const chatRules: Row[] = [
  ...ROLES.flatMap((role) => [
    row({
      name: `${role}: chat.read needs the text capability`,
      actor: actor(role),
      action: 'chat.read',
      resource: { room: room({ capabilities: NO_TEXT }) },
      expected: 'capability_disabled',
    }),
    row({
      name: `${role}: chat.write needs the text capability`,
      actor: actor(role),
      action: 'chat.write',
      resource: { room: room({ capabilities: NO_TEXT }), guestsCanWrite: true },
      expected: 'capability_disabled',
    }),
    row({
      name: `${role} writes where the room keeps guests read-only: ${role === 'guest' ? 'no' : 'yes'}`,
      actor: actor(role),
      action: 'chat.write',
      resource: { room: textRoom(), guestsCanWrite: false },
      expected: role === 'guest' ? 'chat_write_not_allowed' : true,
    }),
    row({
      name: `${role} deletes their own message`,
      actor: actor(role),
      action: 'chat.delete',
      resource: { room: textRoom(), author: target(role, `${role}-1`) },
      expected: true,
    }),
  ]),
  row({
    name: 'owner: chat.delete needs the text capability',
    actor: actor('owner'),
    action: 'chat.delete',
    resource: { room: room({ capabilities: NO_TEXT }), author: target('member') },
    expected: 'capability_disabled',
  }),
  row({
    name: 'room-only guest (room grant) reads and writes',
    actor: actor(null),
    action: 'chat.write',
    resource: { room: textRoom({ actorAccess: grant() }), guestsCanWrite: true },
    expected: true,
  }),
  row({
    name: 'outsider cannot read the chat',
    actor: actor(null),
    action: 'chat.read',
    resource: { room: textRoom() },
    expected: 'not_space_member',
  }),
  row({
    name: 'banned member cannot read the chat',
    actor: actor('member', {
      membership: { spaceId: SPACE.id, role: 'member', bannedAt: NOW - HOUR },
    }),
    action: 'chat.read',
    resource: { room: textRoom() },
    expected: 'banned',
  }),
  row({
    name: 'member without access to a restricted room cannot read its chat',
    actor: actor('member'),
    action: 'chat.read',
    resource: { room: textRoom({ visibility: 'restricted' }) },
    expected: 'room_access_required',
  }),
  row({
    name: 'nobody reads the chat of a closed room',
    actor: actor('owner'),
    action: 'chat.read',
    resource: { room: textRoom({ archivedAt: NOW - HOUR }) },
    expected: 'room_closed',
  }),
  row({
    name: "admin cannot delete the owner's message",
    actor: actor('admin'),
    action: 'chat.delete',
    resource: { room: textRoom(), author: target('owner') },
    expected: 'cannot_act_on_target',
  }),
  row({
    name: "admin cannot delete another admin's message",
    actor: actor('admin'),
    action: 'chat.delete',
    resource: { room: textRoom(), author: target('admin') },
    expected: 'cannot_act_on_target',
  }),
  row({
    name: "owner deletes an admin's message",
    actor: actor('owner'),
    action: 'chat.delete',
    resource: { room: textRoom(), author: target('admin') },
    expected: true,
  }),
  row({
    name: "member cannot delete a guest's message",
    actor: actor('member'),
    action: 'chat.delete',
    resource: { room: textRoom(), author: target('guest') },
    expected: 'insufficient_role',
  }),
];

function run(rows: Row[]) {
  it.each(rows.map((r) => [r.name, r] as const))('%s', (_, r) => {
    const decision = can(r.actor, r.action, r.resource, NOW);
    expect(decision).toEqual(
      r.expected === true ? { allowed: true } : { allowed: false, code: r.expected },
    );
  });
}

describe('can()', () => {
  describe('6.4.4 permission matrix', () => run(matrix));
  describe('6.4.5 guests and the stream permission', () => run(guestRules));
  describe('6.4.3 platform admin', () => run(platformRules));
  describe('general rules', () => run(generalRules));
  describe('REST-only actions', () => run(restRules));
  describe('room capabilities', () => run(capabilityRules));
  describe('voice matrix', () => run(voiceMatrix));
  describe('voice rules', () => run(voiceRules));
  describe('camera matrix', () => run(cameraMatrix));
  describe('camera rules', () => run(cameraRules));

  it('covers every cell of the camera matrix', () => {
    const covered = new Set(cameraMatrix.map((r) => r.cell));
    const missing = CAMERA_MATRIX_ROWS.flatMap((r) =>
      ROLES.map((role) => cameraCell(r, role)),
    ).filter((c) => !covered.has(c));
    expect(missing).toEqual([]);
  });
  describe('chat matrix', () => run(chatMatrix));
  describe('chat rules', () => run(chatRules));

  it('covers every cell of the chat matrix', () => {
    const covered = new Set(chatMatrix.map((r) => r.cell));
    const missing = CHAT_MATRIX_ROWS.flatMap((r) => ROLES.map((role) => chatCell(r, role))).filter(
      (c) => !covered.has(c),
    );
    expect(missing).toEqual([]);
  });

  it('covers every cell of the voice matrix', () => {
    const covered = new Set(voiceMatrix.map((r) => r.cell));
    const missing = VOICE_MATRIX_ROWS.flatMap((r) =>
      ROLES.map((role) => voiceCell(r, role)),
    ).filter((c) => !covered.has(c));
    expect(missing).toEqual([]);
  });

  it('covers every cell of the 6.4.4 matrix', () => {
    const covered = new Set(matrix.map((r) => r.cell));
    const missing = MATRIX_ROWS.flatMap((r) => ROLES.map((role) => cell(r, role))).filter(
      (c) => !covered.has(c),
    );
    expect(missing).toEqual([]);
    expect(covered.size).toBe(MATRIX_ROWS.length * ROLES.length);
  });
});
