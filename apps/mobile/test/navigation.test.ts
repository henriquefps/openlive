// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  INITIAL_STACK,
  instanceRemoved,
  instanceRoute,
  pop,
  push,
  reset,
  sessionLost,
  top,
  type Route,
  withSection,
} from '../src/lib/navigation.ts';

const A = 'https://a.example.com';
const B = 'https://b.example.com';
const space: Route = { name: 'space', origin: A, spaceId: 's1', spaceName: 'Friends' };
const room: Route = { name: 'room', origin: A, spaceId: 's1', roomId: 'r1', roomName: 'Lounge' };

describe('navigation', () => {
  it('pushes and pops, and never pops the bottom screen', () => {
    const stack = push(push(reset(instanceRoute(A)), space), room);
    expect(top(stack)).toBe(room);
    expect(top(pop(stack))).toBe(space);
    expect(pop(INITIAL_STACK)).toBe(INITIAL_STACK);
  });

  it('puts the instance above home', () => {
    expect(reset(instanceRoute(A, 'tok'))).toEqual([
      { name: 'home' },
      { name: 'instance', origin: A, invite: 'tok' },
    ]);
  });

  it('goes back to the instance screen when its session ends', () => {
    const stack = push(push(reset(instanceRoute(A)), space), room);
    expect(sessionLost(stack, A)).toEqual([
      { name: 'home' },
      { name: 'instance', origin: A, expired: true },
    ]);
    // Another instance's session ending leaves this stack alone.
    expect(sessionLost(stack, B)).toBe(stack);
  });

  it('forgets every screen of a removed instance', () => {
    const stack = push(reset(instanceRoute(A)), space);
    expect(instanceRemoved(stack, A)).toEqual([{ name: 'home' }]);
    expect(instanceRemoved(stack, B)).toEqual(stack);
    expect(instanceRemoved([instanceRoute(A)], A)).toEqual(INITIAL_STACK);
  });
});

describe('space sections', () => {
  it('keeps the section on the space route, and rooms is no section', () => {
    const stack = push(reset(instanceRoute(A)), space);
    const members = withSection(stack, 'members');
    expect(top(members)).toEqual({ ...space, section: 'members' });
    expect(top(withSection(members, 'rooms'))).toEqual(space);
  });
  it('keeps the section when a room is opened and closed', () => {
    const stack = withSection(push(reset(instanceRoute(A)), space), 'invites');
    expect(top(pop(push(stack, room)))).toEqual({ ...space, section: 'invites' });
  });
  it('changes nothing when the top screen is not a space', () => {
    const stack = push(push(reset(instanceRoute(A)), space), room);
    expect(withSection(stack, 'members')).toBe(stack);
  });
});
