// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { removeRetiredKeys } from '../src/lib/storage-cleanup.ts';

describe('removeRetiredKeys', () => {
  it('drops the retired "lowest latency" keys and keeps everything else', () => {
    localStorage.clear();
    localStorage.setItem('openlive.lowestLatency.rm_1', '1');
    localStorage.setItem('openlive.lowestLatency.rm_2', '1');
    localStorage.setItem('openlive.theme', 'dark');
    removeRetiredKeys();
    expect(Object.keys(localStorage)).toEqual(['openlive.theme']);
  });

  it('does nothing when storage throws', () => {
    const broken = {
      get length(): number {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(() => removeRetiredKeys(broken)).not.toThrow();
  });
});
