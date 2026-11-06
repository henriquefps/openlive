// SPDX-License-Identifier: AGPL-3.0-only
import {
  assignableRoles,
  canActOn,
  type Invite,
  type Member,
  type Room,
  type Space,
  type SpaceAbilities,
  type SpaceSettings,
  type SettingsPatch,
} from '@openlive/client';
import type { RoomCapabilities, Role } from '@openlive/protocol';
import { aboveCeiling, isValidCapabilities } from './capabilities.ts';
import { SLUG_PATTERN, slugify } from './slug.ts';
import type { Section } from './section-select.ts';

// The rules of the space page's sections (SpaceScreen and screens/space/), pure so they are
// tested without a device. They follow the web's SpacePage and space/*Tab.tsx.

export const SPACE_SECTIONS = [
  'rooms',
  'members',
  'invites',
  'requests',
  'status',
  'settings',
] as const;
export type SpaceSection = (typeof SPACE_SECTIONS)[number];

/** The sections the caller may open, in order: invites, requests and status depend on the role. */
export function visibleSections(
  abilities: Pick<SpaceAbilities, 'viewInvites' | 'decideJoinRequests' | 'viewStatus'>,
): SpaceSection[] {
  return SPACE_SECTIONS.filter(
    (name) =>
      (name !== 'invites' || abilities.viewInvites) &&
      (name !== 'requests' || abilities.decideJoinRequests) &&
      (name !== 'status' || abilities.viewStatus),
  );
}

/** The section on screen: the one asked for when it is visible, else Rooms (as the web). */
export const currentSection = (
  sections: readonly SpaceSection[],
  asked: string | undefined,
): SpaceSection => sections.find((s) => s === asked) ?? 'rooms';

/** The items of the section switcher; Requests carries the pending count. */
export function sectionItems(
  sections: readonly SpaceSection[],
  label: (section: SpaceSection) => string,
  pending: number,
): Section<SpaceSection>[] {
  return sections.map((value) => ({
    value,
    label: label(value),
    badge: value === 'requests' ? pending : undefined,
  }));
}

/** A dot on the switcher: requests are waiting and another section is on screen. */
export const pendingDot = (
  sections: readonly SpaceSection[],
  current: SpaceSection,
  pending: number,
): boolean => pending > 0 && current !== 'requests' && sections.includes('requests');

/**
 * Where back goes from a section, as the web's trail (Spaces > Space > Section): from any section
 * but Rooms to the space itself (Rooms), from Rooms to the list of spaces.
 */
export const backTarget = (current: SpaceSection): 'rooms' | 'spaces' =>
  current === 'rooms' ? 'spaces' : 'rooms';

// --- rooms ---

/** A quick room's join code; rooms opened before codes were stored show their slug in capitals. */
export const quickCode = (room: Pick<Room, 'code' | 'slug'>): string =>
  room.code ?? room.slug.toUpperCase();

/** Rooms still open: not archived and not past their expiry. */
export const openRooms = (rooms: readonly Room[], now: number): Room[] =>
  rooms.filter((r) => r.archivedAt === null && (r.expiresAt === null || r.expiresAt > now));

export interface FixedRoomForm {
  name: string;
  /** What the person typed; null follows the name. */
  slug: string | null;
  capabilities: RoomCapabilities;
}

export interface FixedRoomCheck {
  slug: string;
  slugValid: boolean;
  capabilitiesValid: boolean;
  /** Whether the submit button is enabled. */
  valid: boolean;
}

/** The create-room form as the web validates it: a name, a valid slug, capabilities in range. */
export function checkFixedRoom(form: FixedRoomForm, ceiling: RoomCapabilities): FixedRoomCheck {
  const slug = form.slug ?? slugify(form.name);
  const slugValid = SLUG_PATTERN.test(slug);
  const capabilitiesValid =
    isValidCapabilities(form.capabilities) && aboveCeiling(form.capabilities, ceiling).length === 0;
  return {
    slug,
    slugValid,
    capabilitiesValid,
    valid: form.name.trim() !== '' && slugValid && capabilitiesValid,
  };
}

// --- members ---

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, member: 2, guest: 3 };

/** Active members first, then the banned; by role, then by name. */
export function sortMembers(members: readonly Member[]): { active: Member[]; banned: Member[] } {
  const sorted = [...members].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.displayName.localeCompare(b.displayName),
  );
  return {
    active: sorted.filter((m) => m.bannedAt === null),
    banned: sorted.filter((m) => m.bannedAt !== null),
  };
}

export interface MemberActions {
  /** Roles the caller may give (empty when none, or when the member is banned). */
  roles: ('admin' | 'member' | 'guest')[];
  transfer: boolean;
  remove: boolean;
  ban: boolean;
  unban: boolean;
  /** Whether there is a menu at all (the web hides it for owners and for nothing to do). */
  menu: boolean;
}

/** What the caller may do to a member: the web's MemberRow rules. */
export function memberActions(
  role: Role | null | undefined,
  selfId: string,
  member: Pick<Member, 'userId' | 'role' | 'bannedAt'>,
): MemberActions {
  const actOn = canActOn(role, selfId, member);
  const banned = member.bannedAt !== null;
  const transfer = role === 'owner' && member.userId !== selfId && member.role !== 'guest';
  const menu = (actOn || transfer) && member.role !== 'owner';
  return {
    roles: actOn && !banned ? assignableRoles(role) : [],
    transfer: transfer && !banned,
    remove: actOn && !banned,
    ban: actOn && !banned,
    unban: actOn && banned,
    menu,
  };
}

// --- invites ---

export const EXPIRY_HOURS = [1, 24, 168, 720] as const;
export const MAX_USES_LIMIT = 1000;

export interface InviteForm {
  /** '' is the whole space. */
  roomId: string;
  role: 'member' | 'guest';
  canStream: boolean;
  requiresApproval: boolean;
  maxUses: string;
  expiresInHours: number;
}

export const usesValid = (maxUses: string): boolean => {
  const n = Number(maxUses);
  return maxUses.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= MAX_USES_LIMIT;
};

/** The body of POST /api/spaces/:id/invites, as the web's CreateInviteDialog builds it. */
export function inviteInput(form: InviteForm) {
  const room = form.roomId !== '';
  return {
    roomId: room ? form.roomId : null,
    role: room ? ('guest' as const) : form.role,
    canStream: room && form.canStream,
    requiresApproval: form.requiresApproval,
    maxUses: Number(form.maxUses),
    expiresInHours: form.expiresInHours,
  };
}

/** The web link of an invite token (shown once, at creation). */
export const inviteUrl = (origin: string, token: string): string =>
  `${origin.replace(/\/+$/, '')}/invite/${token}`;

/** The invite's target: the room's name (or id), or null for the whole space. */
export const inviteRoomName = (
  invite: Pick<Invite, 'roomId'>,
  rooms: readonly Room[] | undefined,
) =>
  invite.roomId === null
    ? null
    : (rooms?.find((r) => r.id === invite.roomId)?.name ?? invite.roomId);

// --- settings ---

export const LIMITS = [
  'maxStreams',
  'maxViewersPerStream',
  'maxBitrateKbps',
  'quickRoomHours',
] as const;
export type LimitKey = (typeof LIMITS)[number];

/** Defaults when the space sets nothing (apps/api/src/api/settings.ts). */
export const QUICK_ROOM_DEFAULT_HOURS = 12;

export const toField = (value: number | undefined): string =>
  value === undefined ? '' : String(value);

/** The limits whose text is not an empty field or a whole number (quick rooms last 1 hour or more). */
export function invalidLimits(limits: Record<LimitKey, string>): LimitKey[] {
  return LIMITS.filter((key) => {
    const value = limits[key];
    if (value === '') return false;
    const n = Number(value);
    return !Number.isInteger(n) || n < (key === 'quickRoomHours' ? 1 : 0);
  });
}

/** The values the fields show as placeholders: what applies now. */
export function currentLimits(space: Space): Record<LimitKey, number> {
  return {
    maxStreams: space.effectiveSettings.maxStreams,
    maxViewersPerStream: space.effectiveSettings.maxViewersPerStream,
    maxBitrateKbps: space.effectiveSettings.maxBitrateKbps,
    quickRoomHours: space.settings.quickRoomHours ?? QUICK_ROOM_DEFAULT_HOURS,
  };
}

/** The PATCH of the settings form: an empty limit goes back to the platform's (null). */
export function settingsPatch(
  limits: Record<LimitKey, string>,
  membersCanInviteGuests: boolean,
  capabilities: RoomCapabilities | null,
): SettingsPatch<SpaceSettings> {
  const settings: SettingsPatch<SpaceSettings> = {
    membersCanInviteGuests: membersCanInviteGuests ? null : false,
  };
  for (const key of LIMITS) settings[key] = limits[key] === '' ? null : Number(limits[key]);
  if (capabilities) settings.capabilities = capabilities;
  return settings;
}

// --- time ---

/** A countdown without a language: "2:05:09" from an hour up, "4:07" below. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * The cached queries of one space on one server and user (their key has the space's id): what
 * pull to refresh reads again, whichever section is on screen.
 */
export function isSpaceQuery(
  queryKey: readonly unknown[],
  scope: { origin: string; userId: string },
  spaceId: string,
): boolean {
  return (
    queryKey[0] === 'ol' &&
    queryKey[1] === scope.origin &&
    queryKey[2] === scope.userId &&
    queryKey.slice(4).includes(spaceId) &&
    queryKey[3] !== 'presence'
  );
}
