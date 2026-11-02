// SPDX-License-Identifier: AGPL-3.0-only
// The single authorization function. Pure: callers load the
// actor's membership, the room and the actor's room_access row, then ask.
// Implements the role matrix, the guest rules, the platform admin role, the room capabilities,
// voice and the text chat.

import type { RoomCapabilities } from '@openlive/protocol';

export type SpaceRole = 'owner' | 'admin' | 'member' | 'guest';

export interface Membership {
  spaceId: string;
  role: SpaceRole;
  bannedAt: number | null;
}

export interface Actor {
  userId: string;
  isPlatformAdmin: boolean;
  /** The actor's space_members row in the resource's space, if any. */
  membership: Membership | null;
}

export interface SpaceSettings {
  /** Whether members may invite guests (matrix: "configurable"). */
  membersCanInviteGuests: boolean;
}

export interface SpaceRef {
  id: string;
  settings: SpaceSettings;
}

/** A room_access row. */
export interface RoomGrant {
  canView: boolean;
  canStream: boolean;
  expiresAt: number | null;
}

export interface RoomRef {
  id: string;
  spaceId: string;
  visibility: 'space' | 'restricted';
  archivedAt: number | null;
  expiresAt: number | null;
  /** The actor's room_access row for this room, if any. */
  actorAccess: RoomGrant | null;
  /** What the room has, reduced by what its space and the platform allow. */
  capabilities: RoomCapabilities;
}

/** Another person the action applies to. */
export interface Target {
  userId: string;
  role: SpaceRole;
  /** space_members.invited_by, or room_access.granted_by for room-only guests. */
  invitedBy: string | null;
}

export interface ResourceByAction {
  'room.view': { room: RoomRef };
  /** Stream in the room now: the permission, and the room has the stream capability. */
  'stream.publish': { room: RoomRef };
  /** Watch the room's streams: view, and the room has the stream capability. */
  'stream.subscribe': { room: RoomRef };
  /**
   * Hold the permission to stream in the room, whatever its capabilities: what
   * Permissions.canStream carries (so turning the stream capability back on needs no refresh)
   * and what a grant may not exceed.
   */
  'stream.permission': { room: RoomRef };
  /** Join the room's voice channel and listen: view, and the room has the voice capability. */
  'voice.join': { room: RoomRef };
  /** Publish a microphone in the voice channel; guests only where the room lets them. */
  'voice.speak': { room: RoomRef; guestsCanSpeak: boolean };
  /** Mute someone in the voice channel for everyone: same rule as removing them. */
  'voice.serverMute': { room: RoomRef; target: Target };
  /** Take someone out of the voice channel: same rule as removing them. */
  'voice.kick': { room: RoomRef; target: Target };
  /** Turn a camera on in the voice channel; guests only where the room lets them (default no). */
  'camera.publish': { room: RoomRef; guestsCanUseCamera: boolean };
  /** Turn someone's camera off: same rule as removing them. */
  'camera.moderate': { room: RoomRef; target: Target };
  /** Read the room's text chat and its history: view, and the room has the text capability. */
  'chat.read': { room: RoomRef };
  /** Send and edit one's own chat messages; guests only where the room lets them. */
  'chat.write': { room: RoomRef; guestsCanWrite: boolean };
  /** Delete a chat message: one's own, or someone else's under the rule of removing them. */
  'chat.delete': { room: RoomRef; author: Target };
  'room.quick.create': { space: SpaceRef };
  'room.fixed.manage': { space: SpaceRef };
  /** Edit or end a quick room early: managers, or the member who created it. */
  'room.quick.manage': { space: SpaceRef; createdBy: string | null };
  /** See the space, its members and its room list (access layer 2). */
  'space.view': { space: SpaceRef };
  'invite.create': {
    space: SpaceRef;
    role: 'member' | 'guest';
    canStream: boolean;
    /** Set for a room invite. */
    room: RoomRef | null;
  };
  /** List or revoke an invite: managers, or the member who created it. */
  'invite.manage': { space: SpaceRef; createdBy: string | null };
  /** Give (grant: true) or take away (grant: false) a guest's stream permission in a room. */
  'guest.stream.set': { space: SpaceRef; room: RoomRef; target: Target; grant: boolean };
  'stream.end': { room: RoomRef; streamer: Target };
  'room.participant.remove': { room: RoomRef; target: Target };
  'join_request.decide': { space: SpaceRef };
  'member.role.change': { space: SpaceRef; target: Target; newRole: SpaceRole };
  'member.ban': { space: SpaceRef; target: Target };
  'space.settings.update': { space: SpaceRef };
  /** The space status page: owners and admins, and the platform admin. */
  'space.status.view': { space: SpaceRef };
  'space.delete': { space: SpaceRef };
  'space.transfer': { space: SpaceRef; target: Target };
  'platform.usage.view': Record<string, never>;
  'platform.settings.update': Record<string, never>;
  'platform.space.suspend': { space: SpaceRef };
  /** See every account, its spaces, sessions, devices and activity. */
  'platform.user.view': Record<string, never>;
  /** Ban or unban an account from the whole instance, or sign it out everywhere. */
  'platform.user.ban': Record<string, never>;
  /** Delete an account and its personal data (LGPD). */
  'platform.user.delete': Record<string, never>;
  /** Create a space: the platform admin, or anyone signed in when the policy allows it. */
  'space.create': { policy: SpaceCreationPolicy };
  /**
   * Download the helper from the instance: the platform admin, or anyone who is an
   * unbanned member of at least one space (`memberOfAnySpace`, loaded by the caller).
   */
  'helper.download': { memberOfAnySpace: boolean };
  /**
   * See someone's uploaded profile photo: themselves, the platform admin, or anyone who shares a
   * space with them (`sharesSpace`, loaded by the caller: members, guests and room guests).
   */
  'user.avatar.view': { userId: string; sharesSpace: boolean };
}

/** Who may create spaces (platform setting `spaceCreation`). */
export type SpaceCreationPolicy = 'admin_only' | 'members';

export type Action = keyof ResourceByAction;

export type DenyCode =
  | 'not_space_member'
  | 'banned'
  | 'insufficient_role'
  | 'room_access_required'
  | 'room_closed'
  | 'stream_permission_required'
  | 'member_guest_invites_disabled'
  | 'grant_exceeds_own_permission'
  | 'not_inviter'
  | 'target_not_guest'
  | 'cannot_act_on_target'
  | 'cannot_act_on_self'
  | 'invalid_role'
  | 'platform_admin_required'
  | 'capability_disabled'
  | 'voice_speak_not_allowed'
  | 'camera_not_allowed'
  | 'chat_write_not_allowed';

export type Decision = { allowed: true } | { allowed: false; code: DenyCode };

const ALLOW: Decision = { allowed: true };
const deny = (code: DenyCode): Decision => ({ allowed: false, code });

const isManager = (role: SpaceRole): boolean => role === 'owner' || role === 'admin';

type Lookup<T> = ({ ok: true } & T) | { ok: false; code: DenyCode };

/** The actor's role in a space, or why they have none. */
function spaceRole(actor: Actor, spaceId: string): Lookup<{ role: SpaceRole }> {
  const m = actor.membership;
  if (!m || m.spaceId !== spaceId) return { ok: false, code: 'not_space_member' };
  if (m.bannedAt !== null) return { ok: false, code: 'banned' };
  return { ok: true, role: m.role };
}

function activeGrant(grant: RoomGrant | null, now: number): RoomGrant | null {
  if (!grant) return null;
  if (grant.expiresAt !== null && grant.expiresAt <= now) return null;
  return grant;
}

/**
 * The actor's effective role in a room, if they may see it. Someone with no
 * space membership but an active room_access row is a guest of that room only
 * (room invites and quick rooms by code).
 */
function roomRole(
  actor: Actor,
  room: RoomRef,
  now: number,
): Lookup<{ role: SpaceRole; grant: RoomGrant | null }> {
  if (room.archivedAt !== null || (room.expiresAt !== null && room.expiresAt <= now)) {
    return { ok: false, code: 'room_closed' };
  }
  const grant = activeGrant(room.actorAccess, now);
  const s = spaceRole(actor, room.spaceId);
  if (!s.ok) {
    if (s.code === 'not_space_member' && grant?.canView) return { ok: true, role: 'guest', grant };
    return s;
  }
  if (!isManager(s.role) && room.visibility === 'restricted' && !grant?.canView) {
    return { ok: false, code: 'room_access_required' };
  }
  return { ok: true, role: s.role, grant };
}

function canPublish(actor: Actor, room: RoomRef, now: number): Decision {
  const r = roomRole(actor, room, now);
  if (!r.ok) return deny(r.code);
  if (r.role !== 'guest') return ALLOW;
  return r.grant?.canStream ? ALLOW : deny('stream_permission_required');
}

/** Owners act on anyone but themselves; admins only on members and guests. */
function canActOn(role: SpaceRole, actorUserId: string, target: Target): Decision {
  if (target.userId === actorUserId) return deny('cannot_act_on_self');
  if (role === 'owner') return ALLOW;
  if (role === 'admin') return isManager(target.role) ? deny('cannot_act_on_target') : ALLOW;
  return deny('insufficient_role');
}

function requireRole(actor: Actor, spaceId: string, allowed: readonly SpaceRole[]): Decision {
  const s = spaceRole(actor, spaceId);
  if (!s.ok) return deny(s.code);
  return allowed.includes(s.role) ? ALLOW : deny('insufficient_role');
}

// Voice, once the actor's role in the room is known. can() uses
// these after roomRole(); the RoomDO uses them directly, since it holds each connection's role
// and the room's settings rather than the D1 rows.

export function canJoinVoiceAs(capabilities: RoomCapabilities): Decision {
  return capabilities.voice ? ALLOW : deny('capability_disabled');
}

/** Everyone in the room speaks; guests only when the room's guestsCanSpeak is on (the default). */
export function canSpeakAs(
  role: SpaceRole,
  capabilities: RoomCapabilities,
  guestsCanSpeak: boolean,
): Decision {
  const join = canJoinVoiceAs(capabilities);
  if (!join.allowed) return join;
  return role !== 'guest' || guestsCanSpeak ? ALLOW : deny('voice_speak_not_allowed');
}

/** voice.serverMute and voice.kick: owners and admins, under the rule of removing someone. */
export function canModerateVoiceAs(
  role: SpaceRole,
  actorUserId: string,
  capabilities: RoomCapabilities,
  target: Target,
): Decision {
  const join = canJoinVoiceAs(capabilities);
  if (!join.allowed) return join;
  if (target.userId === actorUserId) return deny('cannot_act_on_self');
  if (!isManager(role)) return deny('insufficient_role');
  return canActOn(role, actorUserId, target);
}

// Cameras: a sub-option of voice, so the camera capability only
// counts with voice on (intersect() keeps that true for stored settings).

export function canUseCameraAs(
  role: SpaceRole,
  capabilities: RoomCapabilities,
  guestsCanUseCamera: boolean,
): Decision {
  if (!capabilities.voice || !capabilities.camera) return deny('capability_disabled');
  return role !== 'guest' || guestsCanUseCamera ? ALLOW : deny('camera_not_allowed');
}

/** voice.cameraOff: owners and admins, under the rule of removing someone. */
export function canModerateCameraAs(
  role: SpaceRole,
  actorUserId: string,
  capabilities: RoomCapabilities,
  target: Target,
): Decision {
  if (!capabilities.voice || !capabilities.camera) return deny('capability_disabled');
  return canModerateVoiceAs(role, actorUserId, capabilities, target);
}
// Text chat, the same way: can() after roomRole(), the RoomDO
// directly with the connection's role and the room's settings.

export function canReadChatAs(capabilities: RoomCapabilities): Decision {
  return capabilities.text ? ALLOW : deny('capability_disabled');
}

/** Everyone in the room writes; guests only when the room's guestsCanWrite is on (the default). */
export function canWriteChatAs(
  role: SpaceRole,
  capabilities: RoomCapabilities,
  guestsCanWrite: boolean,
): Decision {
  const read = canReadChatAs(capabilities);
  if (!read.allowed) return read;
  return role !== 'guest' || guestsCanWrite ? ALLOW : deny('chat_write_not_allowed');
}

/**
 * Deleting a message: the author always (while the room has text); owners and admins someone
 * else's under the rule of removing them. A removed account's message has a guest as `author`.
 */
export function canDeleteChatAs(
  role: SpaceRole,
  actorUserId: string,
  capabilities: RoomCapabilities,
  author: Target,
): Decision {
  const read = canReadChatAs(capabilities);
  if (!read.allowed) return read;
  if (author.userId === actorUserId) return ALLOW;
  if (!isManager(role)) return deny('insufficient_role');
  return canActOn(role, actorUserId, author);
}

const MANAGERS = ['owner', 'admin'] as const;
const NON_GUESTS = ['owner', 'admin', 'member'] as const;
const ROLES = ['owner', 'admin', 'member', 'guest'] as const;

export function can<A extends Action>(
  actor: Actor,
  action: A,
  resource: ResourceByAction[A],
  now: number = Date.now(),
): Decision {
  // The switch narrows `action`, not `resource`; this view of the pair lets it do both.
  const req = { action, resource } as {
    [K in Action]: { action: K; resource: ResourceByAction[K] };
  }[Action];

  switch (req.action) {
    case 'platform.usage.view':
    case 'platform.settings.update':
    case 'platform.space.suspend':
    case 'platform.user.view':
    case 'platform.user.ban':
    case 'platform.user.delete':
      return actor.isPlatformAdmin ? ALLOW : deny('platform_admin_required');

    case 'space.create':
      return actor.isPlatformAdmin || req.resource.policy === 'members'
        ? ALLOW
        : deny('platform_admin_required');

    case 'helper.download':
      return actor.isPlatformAdmin || req.resource.memberOfAnySpace
        ? ALLOW
        : deny('not_space_member');

    case 'user.avatar.view':
      return actor.isPlatformAdmin ||
        actor.userId === req.resource.userId ||
        req.resource.sharesSpace
        ? ALLOW
        : deny('not_space_member');

    case 'room.view': {
      const r = roomRole(actor, req.resource.room, now);
      return r.ok ? ALLOW : deny(r.code);
    }

    case 'stream.permission':
      return canPublish(actor, req.resource.room, now);

    case 'stream.publish': {
      // Who may see the room learns that it has no stream (before any permission question);
      // others get their usual refusal.
      const d = canPublish(actor, req.resource.room, now);
      if (!d.allowed && d.code !== 'stream_permission_required') return d;
      if (!req.resource.room.capabilities.stream) return deny('capability_disabled');
      return d;
    }

    case 'stream.subscribe': {
      const r = roomRole(actor, req.resource.room, now);
      if (!r.ok) return deny(r.code);
      return req.resource.room.capabilities.stream ? ALLOW : deny('capability_disabled');
    }

    case 'voice.join': {
      const r = roomRole(actor, req.resource.room, now);
      return r.ok ? canJoinVoiceAs(req.resource.room.capabilities) : deny(r.code);
    }

    case 'voice.speak': {
      const r = roomRole(actor, req.resource.room, now);
      if (!r.ok) return deny(r.code);
      return canSpeakAs(r.role, req.resource.room.capabilities, req.resource.guestsCanSpeak);
    }

    case 'voice.serverMute':
    case 'voice.kick': {
      const r = roomRole(actor, req.resource.room, now);
      if (!r.ok) return deny(r.code);
      const { room, target } = req.resource;
      return canModerateVoiceAs(r.role, actor.userId, room.capabilities, target);
    }

    case 'camera.publish': {
      const r = roomRole(actor, req.resource.room, now);
      if (!r.ok) return deny(r.code);
      return canUseCameraAs(
        r.role,
        req.resource.room.capabilities,
        req.resource.guestsCanUseCamera,
      );
    }

    case 'camera.moderate': {
      const r = roomRole(actor, req.resource.room, now);
      if (!r.ok) return deny(r.code);
      const { room, target } = req.resource;
      return canModerateCameraAs(r.role, actor.userId, room.capabilities, target);
    }
    case 'chat.read': {
      const r = roomRole(actor, req.resource.room, now);
      return r.ok ? canReadChatAs(req.resource.room.capabilities) : deny(r.code);
    }

    case 'chat.write': {
      const r = roomRole(actor, req.resource.room, now);
      if (!r.ok) return deny(r.code);
      return canWriteChatAs(r.role, req.resource.room.capabilities, req.resource.guestsCanWrite);
    }

    case 'chat.delete': {
      const r = roomRole(actor, req.resource.room, now);
      if (!r.ok) return deny(r.code);
      const { room, author } = req.resource;
      return canDeleteChatAs(r.role, actor.userId, room.capabilities, author);
    }

    case 'space.view':
      return requireRole(actor, req.resource.space.id, ROLES);

    case 'room.quick.create':
      return requireRole(actor, req.resource.space.id, NON_GUESTS);

    case 'room.quick.manage':
    case 'invite.manage': {
      const s = spaceRole(actor, req.resource.space.id);
      if (!s.ok) return deny(s.code);
      if (isManager(s.role)) return ALLOW;
      if (s.role === 'guest') return deny('insufficient_role');
      return req.resource.createdBy === actor.userId ? ALLOW : deny('insufficient_role');
    }

    case 'space.status.view':
      if (actor.isPlatformAdmin) return ALLOW;
      return requireRole(actor, req.resource.space.id, MANAGERS);

    case 'room.fixed.manage':
    case 'join_request.decide':
    case 'space.settings.update':
      return requireRole(actor, req.resource.space.id, MANAGERS);

    case 'space.delete':
      return requireRole(actor, req.resource.space.id, ['owner']);

    case 'space.transfer': {
      const d = requireRole(actor, req.resource.space.id, ['owner']);
      if (!d.allowed) return d;
      if (req.resource.target.userId === actor.userId) return deny('cannot_act_on_self');
      return req.resource.target.role === 'guest' ? deny('invalid_role') : ALLOW;
    }

    case 'invite.create': {
      const { space, role: inviteRole, canStream, room } = req.resource;
      const s = spaceRole(actor, space.id);
      if (!s.ok) return deny(s.code);
      if (s.role === 'guest') return deny('insufficient_role');
      if (s.role === 'member') {
        if (inviteRole === 'member') return deny('insufficient_role');
        if (!space.settings.membersCanInviteGuests) return deny('member_guest_invites_disabled');
      }
      if (room) {
        if (room.spaceId !== space.id) return deny('room_access_required');
        const view = roomRole(actor, room, now);
        if (!view.ok) return deny(view.code);
        // An invite may carry the stream permission only if the inviter could grant it.
        if (canStream && !canPublish(actor, room, now).allowed) {
          return deny('grant_exceeds_own_permission');
        }
      }
      return ALLOW;
    }

    case 'guest.stream.set': {
      const { space, room, target, grant } = req.resource;
      const s = spaceRole(actor, space.id);
      if (!s.ok) return deny(s.code);
      if (s.role === 'guest') return deny('insufficient_role');
      if (target.role !== 'guest') return deny('target_not_guest');
      if (s.role === 'member' && target.invitedBy !== actor.userId) return deny('not_inviter');
      if (room.spaceId !== space.id) return deny('room_access_required');
      // Nobody grants a permission they don't have. Revoking is always allowed.
      if (grant && !canPublish(actor, room, now).allowed) {
        return deny('grant_exceeds_own_permission');
      }
      return ALLOW;
    }

    case 'stream.end':
    case 'room.participant.remove': {
      const { room } = req.resource;
      const target = req.action === 'stream.end' ? req.resource.streamer : req.resource.target;
      const r = roomRole(actor, room, now);
      if (!r.ok) return deny(r.code);
      // Everyone may end their own stream or leave the room.
      if (target.userId === actor.userId) return ALLOW;
      if (!isManager(r.role)) return deny('insufficient_role');
      return canActOn(r.role, actor.userId, target);
    }

    case 'member.role.change': {
      const { space, target, newRole } = req.resource;
      const s = spaceRole(actor, space.id);
      if (!s.ok) return deny(s.code);
      if (!isManager(s.role)) return deny('insufficient_role');
      // Ownership moves only through space.transfer.
      if (newRole === 'owner') return deny('invalid_role');
      // Admins promote up to member, never to admin.
      if (s.role === 'admin' && newRole === 'admin') return deny('grant_exceeds_own_permission');
      return canActOn(s.role, actor.userId, target);
    }

    case 'member.ban': {
      const { space, target } = req.resource;
      const s = spaceRole(actor, space.id);
      if (!s.ok) return deny(s.code);
      if (!isManager(s.role)) return deny('insufficient_role');
      return canActOn(s.role, actor.userId, target);
    }
  }
}
