// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { keys } from '../src/lib/cache.ts';
import { spaceEntries, staleAfter, staleAfterLeaving } from '../src/lib/space-keys.ts';

const scope = { origin: 'https://a.example', userId: 'u1' };
const k = keys(scope);

describe('space cache keys', () => {
  it('start with the server and the user, like every other key', () => {
    for (const key of [
      k.space('s'),
      k.members('s'),
      k.invites('s'),
      k.joinRequests('s'),
      k.status('s', '24h'),
    ]) {
      expect(key.slice(0, 3)).toEqual(['ol', scope.origin, 'u1']);
    }
  });
  it('keep invites apart from the invite preview, which is never saved', () => {
    expect(k.invites('s')[3]).toBe('invites');
    expect(k.invite('tok')[3]).toBe('invite');
  });
});

describe('what each change makes stale', () => {
  it('refreshes what the change touched', () => {
    expect(staleAfter(scope, 's', 'changeRole')).toEqual([k.members('s')]);
    expect(staleAfter(scope, 's', 'setBanned')).toEqual([k.members('s')]);
    expect(staleAfter(scope, 's', 'createRoom')).toEqual([k.rooms('s')]);
    expect(staleAfter(scope, 's', 'createInvite')).toEqual([k.invites('s')]);
    expect(staleAfter(scope, 's', 'revokeInvite')).toEqual([k.invites('s')]);
  });
  it('refreshes members and the list of spaces when someone is removed', () => {
    expect(staleAfter(scope, 's', 'removeMember')).toEqual([k.members('s'), k.spaces()]);
  });
  it('refreshes requests and members after a decision (an approved person is a member)', () => {
    expect(staleAfter(scope, 's', 'decideJoinRequest')).toEqual([
      k.joinRequests('s'),
      k.members('s'),
    ]);
  });
  it('refreshes the space, its rooms and the list after a rename', () => {
    expect(staleAfter(scope, 's', 'updateSpace')).toEqual([k.space('s'), k.rooms('s'), k.spaces()]);
  });
  it('refreshes the space and members after a transfer', () => {
    expect(staleAfter(scope, 's', 'transferSpace')).toEqual([
      k.space('s'),
      k.members('s'),
      k.spaces(),
    ]);
  });
  it('leaving or deleting reads the list again and drops the space entries', () => {
    expect(staleAfterLeaving(scope)).toEqual([k.spaces()]);
    const gone = spaceEntries(scope, 's');
    expect(gone).toContainEqual(k.members('s'));
    expect(gone).toContainEqual(k.space('s'));
    expect(gone).not.toContainEqual(k.spaces());
  });
});
