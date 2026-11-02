// SPDX-License-Identifier: AGPL-3.0-only
// The local stack the screenshots are taken against: wrangler dev (API) and Vite (web) on their
// own ports with a throwaway D1/DO/R2 state, plus the helper processes. Every process is started
// in its own process group and killed with it, so nothing outlives the run.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SHOTS_API_PORT and SHOTS_WEB_PORT move them, so two checkouts can take screenshots side by side.
export const API_PORT = Number(process.env['SHOTS_API_PORT'] ?? 8799);
export const WEB_PORT = Number(process.env['SHOTS_WEB_PORT'] ?? 5188);
export const API = `http://localhost:${API_PORT}`;
export const WEB = `http://localhost:${WEB_PORT}`;

const children: ChildProcess[] = [];
const temps: string[] = [];

/** A throwaway directory, removed by Stack.cleanup(). */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `openlive-shots-${prefix}-`));
  temps.push(dir);
  return dir;
}

export function log(...args: unknown[]): void {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts a long-running process in its own group; its output goes to `onLine` (or nowhere). */
export function start(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void },
): ChildProcess {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) opts.onLine?.(line);
    });
  }
  return child;
}

export function stopAll(): void {
  for (const child of children.reverse()) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

export async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`${url} did not answer`);
      await sleep(500);
    }
  }
}

function assertPortsFree(): void {
  const listening = execFileSync('ss', ['-ltnH'], { encoding: 'utf8' });
  for (const port of [API_PORT, WEB_PORT]) {
    if (new RegExp(`:${port}\\s`).test(listening)) {
      throw new Error(`port ${port} is in use; stop whatever runs there first`);
    }
  }
}

/**
 * The dev Realtime credentials, for live video: OPENLIVE_DEV_VARS, else `.dev.vars` at the root
 * of the main checkout (worktrees share it). Passed to wrangler with --env-file; never read here.
 */
export function devVarsFile(repo: string): string | null {
  const explicit = process.env['OPENLIVE_DEV_VARS'];
  if (explicit) return existsSync(explicit) ? explicit : null;
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
  for (const candidate of [join(repo, '.dev.vars'), join(common, '..', '.dev.vars')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface Stack {
  state: string;
  /** Whether the dev Realtime credentials were found, so streams can go live. */
  live: boolean;
  d1(sql: string): void;
  cleanup(): void;
}

export async function startStack(repo: string): Promise<Stack> {
  assertPortsFree();
  const apiDir = join(repo, 'apps', 'api');
  const wrangler = join(apiDir, 'node_modules', '.bin', 'wrangler');
  const state = tempDir('state');
  const quiet = { cwd: apiDir, stdio: 'ignore' as const };
  execFileSync(
    wrangler,
    ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state],
    quiet,
  );

  const envFile = devVarsFile(repo);
  log(envFile ? 'dev Realtime credentials found' : 'no .dev.vars: no live video in the shots');
  const vars = ['DEV_AUTH:1', `SESSION_SECRET:${randomBytes(32).toString('base64')}`];
  start(
    wrangler,
    [
      'dev',
      '--port',
      String(API_PORT),
      '--persist-to',
      state,
      '--local-upstream',
      `localhost:${WEB_PORT}`,
      '--upstream-protocol',
      'http',
      ...(envFile ? ['--env-file', envFile] : []),
      ...vars.flatMap((v) => ['--var', v]),
    ],
    { cwd: apiDir, onLine: (l) => process.env['VERBOSE'] && console.log('[api]', l) },
  );
  start(join(repo, 'apps', 'web', 'node_modules', '.bin', 'vite'), [], {
    cwd: join(repo, 'apps', 'web'),
    env: { OPENLIVE_API: API, OPENLIVE_WEB_PORT: String(WEB_PORT) },
    onLine: (l) => process.env['VERBOSE'] && console.log('[web]', l),
  });
  await waitForHttp(`${API}/api/auth/policy`);
  await waitForHttp(WEB);
  log(`API on ${API}, web on ${WEB}`);

  return {
    state,
    live: envFile !== null,
    d1(sql) {
      execFileSync(
        wrangler,
        ['d1', 'execute', 'DB', '--local', '--persist-to', state, '--command', sql],
        quiet,
      );
    },
    cleanup() {
      stopAll();
      for (const dir of temps) rmSync(dir, { recursive: true, force: true });
    },
  };
}
