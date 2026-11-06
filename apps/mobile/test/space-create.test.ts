// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { canCreateSpace, checkNewSpace } from '../src/lib/space-create.ts';

describe('checkNewSpace', () => {
  it('suggests the address from the name until it is edited', () => {
    expect(checkNewSpace('Game Night é Ótimo', null)).toEqual({
      slug: 'game-night-e-otimo',
      slugValid: true,
      valid: true,
    });
    expect(checkNewSpace('Game Night', 'mine').slug).toBe('mine');
  });
  it('needs a name and a valid address', () => {
    expect(checkNewSpace('  ', null).valid).toBe(false);
    expect(checkNewSpace('Friends', '-bad-').valid).toBe(false);
    expect(checkNewSpace('???', null).slugValid).toBe(false);
    expect(checkNewSpace('Friends', 'a'.repeat(49)).slugValid).toBe(false);
  });
});

describe('canCreateSpace', () => {
  it('hides the button only when the server says no', () => {
    expect(canCreateSpace({ canCreateSpace: false })).toBe(false);
    expect(canCreateSpace({ canCreateSpace: true })).toBe(true);
    expect(canCreateSpace({})).toBe(true);
    expect(canCreateSpace(undefined)).toBe(true);
  });
});
