// SPDX-License-Identifier: AGPL-3.0-only
// What the deployed Worker reports as its build (GET /api/health): the short git commit, with
// "-dirty" when tracked files have uncommitted changes, and the build time. The setup passes both
// as the Worker vars APP_COMMIT and APP_BUILT_AT in the generated config (config.ts).

import { spawnSync } from 'node:child_process';

export interface BuildInfo {
  commit: string;
  builtAt: string;
}

/** `git status --porcelain --untracked-files=no` output: any line is a tracked change. */
export function isDirty(porcelain: string): boolean {
  return porcelain.trim() !== '';
}

export function commitLabel(shortHash: string, porcelain: string): string {
  return `${shortHash.trim()}${isDirty(porcelain) ? '-dirty' : ''}`;
}

/** Reads the checkout at `cwd`; null when it is not a git checkout (a source archive). */
export function readBuildInfo(cwd: string, now: Date = new Date()): BuildInfo | null {
  const git = (args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const head = git(['rev-parse', '--short', 'HEAD']);
  if (head.status !== 0) return null;
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  if (status.status !== 0) return null;
  return {
    commit: commitLabel(head.stdout, status.stdout),
    builtAt: now.toISOString(),
  };
}
