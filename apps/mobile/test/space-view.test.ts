// SPDX-License-Identifier: AGPL-3.0-only
import { type Member, type Room, spaceAbilities } from '@openlive/client';
import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../src/lib/capabilities.ts';
import {
  backTarget,
  checkFixedRoom,
  currentLimits,
  currentSection,
  formatRemaining,
  inviteInput,
  inviteUrl,
  invalidLimits,
  isSpaceQuery,
  memberActions,
  openRooms,
  pendingDot,
  quickCode,
  sectionItems,
  settingsPatch,
  sortMembers,
  usesValid,
  visibleSections,
} from '../src/lib/space-view.ts';

const abilitiesOf = (role: 'owner' | 'admin' | 'member' | 'guest' | null, invite = true) =>
  spaceAbilities({ role, settings: invite ? {} : { membersCanInviteGuests: false } });

describe('sections by ability', () => {
  it('owners and admins see every section', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(visibleSections(abilitiesOf(role))).toEqual([
        'rooms',
        'members',
        'invites',
        'requests',
        'status',
        'settings',
      ]);
    }
  });
  it('members see invites but not requests or status; guests see neither', () => {
    expect(visibleSections(abilitiesOf('member'))).toEqual([
      'rooms',
      'members',
      'invites',
      'settings',
    ]);
    expect(visibleSections(abilitiesOf('guest'))).toEqual(['rooms', 'members', 'settings']);
    expect(visibleSections(abilitiesOf(null))).toEqual(['rooms', 'members', 'settings']);
  });
  it('falls back to rooms for a section the role does not have', () => {
    const sections = visibleSections(abilitiesOf('member'));
    expect(currentSection(sections, 'status')).toBe('rooms');
    expect(currentSection(sections, 'invites')).toBe('invites');
    expect(currentSection(sections, undefined)).toBe('rooms');
  });
  it('puts the pending count on requests only', () => {
    const items = sectionItems(visibleSections(abilitiesOf('admin')), (s) => s, 3);
    expect(items.find((i) => i.value === 'requests')?.badge).toBe(3);
    expect(items.filter((i) => i.badge !== undefined)).toHaveLength(1);
  });
  it('goes back to the rooms from a section and to the spaces from the rooms', () => {
    expect(backTarget('members')).toBe('rooms');
    expect(backTarget('rooms')).toBe('spaces');
  });
});

describe('pending dot', () => {
  const sections = visibleSections(abilitiesOf('owner'));
  it('shows while requests wait and another section is open', () => {
    expect(pendingDot(sections, 'rooms', 2)).toBe(true);
    expect(pendingDot(sections, 'requests', 2)).toBe(false);
    expect(pendingDot(sections, 'rooms', 0)).toBe(false);
  });
  it('never shows for a role without the requests section', () => {
    expect(pendingDot(visibleSections(abilitiesOf('member')), 'rooms', 2)).toBe(false);
  });
});

const room = (over: Partial<Room>): Room =>
  ({
    id: 'r',
    kind: 'fixed',
    slug: 'abc',
    code: null,
    expiresAt: null,
    archivedAt: null,
    ...over,
  }) as Room;

describe('rooms', () => {
  it('shows the code of a quick room, or its slug in capitals for old ones', () => {
    expect(quickCode({ code: 'OL-4821-0937', slug: 'x' })).toBe('OL-4821-0937');
    expect(quickCode({ code: null, slug: 'abcd' })).toBe('ABCD');
  });
  it('keeps rooms that are not archived or expired', () => {
    const rooms = [
      room({ id: 'a' }),
      room({ id: 'b', archivedAt: 5 }),
      room({ id: 'c', kind: 'quick', expiresAt: 100 }),
      room({ id: 'd', kind: 'quick', expiresAt: 900 }),
    ];
    expect(openRooms(rooms, 500).map((r) => r.id)).toEqual(['a', 'd']);
  });
  it('counts down', () => {
    expect(formatRemaining(67_000)).toBe('1:07');
    expect(formatRemaining(2 * 3600_000 + 5 * 60_000 + 9_000)).toBe('2:05:09');
    expect(formatRemaining(-5)).toBe('0:00');
  });
});

describe('create room form', () => {
  const all = { stream: true, voice: true, camera: true, text: true };
  it('follows the name for the address until it is edited', () => {
    const c = checkFixedRoom(
      { name: 'Game Night', slug: null, capabilities: TEMPLATES.watchTogether },
      all,
    );
    expect(c.slug).toBe('game-night');
    expect(c.valid).toBe(true);
    expect(
      checkFixedRoom(
        { name: 'Game Night', slug: 'Bad Slug', capabilities: TEMPLATES.watchTogether },
        all,
      ).valid,
    ).toBe(false);
  });
  it('needs a name and an address', () => {
    expect(
      checkFixedRoom({ name: '  ', slug: null, capabilities: TEMPLATES.voice }, all).valid,
    ).toBe(false);
    expect(
      checkFixedRoom({ name: '!!!', slug: null, capabilities: TEMPLATES.voice }, all).slugValid,
    ).toBe(false);
  });
  it('refuses capabilities the space does not allow or that are invalid', () => {
    const ceiling = { stream: true, voice: false, camera: false, text: true };
    expect(
      checkFixedRoom({ name: 'a', slug: null, capabilities: TEMPLATES.voice }, ceiling).valid,
    ).toBe(false);
    expect(
      checkFixedRoom({ name: 'a', slug: null, capabilities: TEMPLATES.text }, ceiling).valid,
    ).toBe(true);
    const none = { stream: false, voice: false, camera: false, text: false };
    expect(
      checkFixedRoom({ name: 'a', slug: null, capabilities: none }, all).capabilitiesValid,
    ).toBe(false);
    const cameraOnly = { stream: true, voice: false, camera: true, text: false };
    expect(
      checkFixedRoom({ name: 'a', slug: null, capabilities: cameraOnly }, all).capabilitiesValid,
    ).toBe(false);
  });
});

const member = (over: Partial<Member>): Member => ({
  userId: 'u',
  displayName: 'Ana',
  avatarUrl: null,
  role: 'member',
  invitedBy: null,
  joinedAt: 0,
  bannedAt: null,
  ...over,
});

describe('member actions', () => {
  it('lets an owner change anyone but themselves and the owner row has no menu', () => {
    const a = memberActions('owner', 'me', member({ role: 'admin' }));
    expect(a.roles).toEqual(['admin', 'member', 'guest']);
    expect(a.transfer && a.remove && a.ban && a.menu).toBe(true);
    expect(memberActions('owner', 'me', member({ userId: 'me', role: 'owner' })).menu).toBe(false);
    expect(memberActions('admin', 'me', member({ role: 'owner' })).menu).toBe(false);
  });
  it('limits an admin to members and guests, without transfer', () => {
    const a = memberActions('admin', 'me', member({ role: 'member' }));
    expect(a.roles).toEqual(['member', 'guest']);
    expect(a.transfer).toBe(false);
    expect(memberActions('admin', 'me', member({ role: 'admin' })).menu).toBe(false);
  });
  it('lets an owner hand ownership to a member but not a guest', () => {
    expect(memberActions('owner', 'me', member({ role: 'guest' })).transfer).toBe(false);
    expect(memberActions('owner', 'me', member({ role: 'member' })).transfer).toBe(true);
  });
  it('offers only unban for a banned member', () => {
    const a = memberActions('owner', 'me', member({ bannedAt: 5 }));
    expect(a).toMatchObject({ roles: [], transfer: false, remove: false, ban: false, unban: true });
  });
  it('gives members and guests nothing', () => {
    expect(memberActions('member', 'me', member({ role: 'guest' })).menu).toBe(false);
    expect(memberActions('guest', 'me', member({})).menu).toBe(false);
  });
  it('sorts by role then name, banned apart', () => {
    const { active, banned } = sortMembers([
      member({ userId: '1', displayName: 'Zed', role: 'member' }),
      member({ userId: '2', displayName: 'Bea', role: 'owner' }),
      member({ userId: '3', displayName: 'Ann', role: 'member' }),
      member({ userId: '4', displayName: 'Gus', role: 'guest', bannedAt: 1 }),
    ]);
    expect(active.map((m) => m.userId)).toEqual(['2', '3', '1']);
    expect(banned.map((m) => m.userId)).toEqual(['4']);
  });
});

describe('invites', () => {
  const form = {
    roomId: '',
    role: 'member' as const,
    canStream: true,
    requiresApproval: true,
    maxUses: '5',
    expiresInHours: 24,
  };
  it('validates the number of uses (1 to 1000, whole)', () => {
    for (const ok of ['1', '1000', '25']) expect(usesValid(ok)).toBe(true);
    for (const bad of ['', '0', '1001', '1.5', 'x', '-2']) expect(usesValid(bad)).toBe(false);
  });
  it('builds a space invite with the chosen role and no stream flag', () => {
    expect(inviteInput(form)).toEqual({
      roomId: null,
      role: 'member',
      canStream: false,
      requiresApproval: true,
      maxUses: 5,
      expiresInHours: 24,
    });
  });
  it('builds a room invite as guest, with the stream flag', () => {
    expect(inviteInput({ ...form, roomId: 'r1' })).toMatchObject({
      roomId: 'r1',
      role: 'guest',
      canStream: true,
    });
  });
  it('writes the link on the instance origin', () => {
    expect(inviteUrl('https://x.example/', 'tok')).toBe('https://x.example/invite/tok');
  });
});

describe('settings form', () => {
  const empty = { maxStreams: '', maxViewersPerStream: '', maxBitrateKbps: '', quickRoomHours: '' };
  it('accepts empty limits and whole numbers, refuses the rest', () => {
    expect(invalidLimits(empty)).toEqual([]);
    expect(invalidLimits({ ...empty, maxStreams: '0', quickRoomHours: '1' })).toEqual([]);
    expect(invalidLimits({ ...empty, quickRoomHours: '0' })).toEqual(['quickRoomHours']);
    expect(invalidLimits({ ...empty, maxBitrateKbps: '1.5', maxStreams: '-1' })).toEqual([
      'maxStreams',
      'maxBitrateKbps',
    ]);
  });
  it('sends empty limits as null and the capabilities only when changed', () => {
    const patch = settingsPatch({ ...empty, maxStreams: '3' }, true, null);
    expect(patch).toEqual({
      membersCanInviteGuests: null,
      maxStreams: 3,
      maxViewersPerStream: null,
      maxBitrateKbps: null,
      quickRoomHours: null,
    });
    expect(settingsPatch(empty, false, TEMPLATES.text).membersCanInviteGuests).toBe(false);
    expect(settingsPatch(empty, false, TEMPLATES.text).capabilities).toEqual(TEMPLATES.text);
  });
  it('shows the quick room default of 12 hours', () => {
    const space = {
      settings: {},
      effectiveSettings: { maxStreams: 2, maxViewersPerStream: 9, maxBitrateKbps: 5 },
    } as Parameters<typeof currentLimits>[0];
    expect(currentLimits(space).quickRoomHours).toBe(12);
  });
});

describe('space queries', () => {
  const scope = { origin: 'https://a.example', userId: 'u1' };
  it('recognises the cached entries of one space, not the socket snapshot', () => {
    expect(isSpaceQuery(['ol', scope.origin, 'u1', 'members', 's1'], scope, 's1')).toBe(true);
    expect(isSpaceQuery(['ol', scope.origin, 'u1', 'status', 's1', '24h'], scope, 's1')).toBe(true);
    expect(isSpaceQuery(['ol', scope.origin, 'u1', 'members', 's2'], scope, 's1')).toBe(false);
    expect(isSpaceQuery(['ol', scope.origin, 'u2', 'members', 's1'], scope, 's1')).toBe(false);
    expect(isSpaceQuery(['ol', scope.origin, 'u1', 'presence', 's1'], scope, 's1')).toBe(false);
  });
});
