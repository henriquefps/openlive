// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitLabel, isDirty, readBuildInfo } from '../src/build-info.ts';

describe('dirty detection', () => {
  it('is clean on empty status output, dirty on any tracked change', () => {
    expect(isDirty('')).toBe(false);
    expect(isDirty('\n')).toBe(false);
    expect(isDirty(' M apps/api/src/index.ts\n')).toBe(true);
  });

  it('labels the commit', () => {
    expect(commitLabel('c820e1f\n', '')).toBe('c820e1f');
    expect(commitLabel('c820e1f\n', 'M  a.ts\n')).toBe('c820e1f-dirty');
  });
});

describe('readBuildInfo', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      stdio: 'pipe',
    });

  it('reads a checkout: clean, then dirty after a tracked edit, ignoring untracked files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openlive-build-info-'));
    try {
      git(dir, 'init', '-q');
      writeFileSync(join(dir, 'a.txt'), 'one');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'init');
      const now = new Date('2026-10-28T12:00:00Z');
      const short = git(dir, 'rev-parse', '--short', 'HEAD').toString().trim();

      expect(readBuildInfo(dir, now)).toEqual({
        commit: short,
        builtAt: '2026-10-28T12:00:00.000Z',
      });
      writeFileSync(join(dir, 'untracked.txt'), 'x');
      expect(readBuildInfo(dir, now)?.commit).toBe(short);
      writeFileSync(join(dir, 'a.txt'), 'two');
      expect(readBuildInfo(dir, now)?.commit).toBe(`${short}-dirty`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is null outside a git checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openlive-build-info-'));
    try {
      expect(readBuildInfo(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
