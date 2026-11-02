// SPDX-License-Identifier: AGPL-3.0-only
// The calls the setup makes to Cloudflare, through the pinned wrangler (apps/api) and cf
// (this package) binaries. Child output is printed through a redactor, so a secret value that a
// tool echoes never reaches the terminal.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface Tools {
  apiDir: string;
  repoRoot: string;
  /** Added to the children's environment (CLOUDFLARE_ACCOUNT_ID once it is known). */
  env: Record<string, string>;
  redact: (text: string) => string;
}

const win = process.platform === 'win32';

function bin(dir: string, name: string): string {
  return join(dir, 'node_modules', '.bin', win ? `${name}.cmd` : name);
}

interface ExecOptions {
  cwd: string;
  /** Capture stdout instead of showing it (JSON output, or output that holds a secret). */
  capture?: boolean;
  /** Run without a terminal on stdin, so tools skip their own confirmation prompts. */
  noStdin?: boolean;
}

function exec(tools: Tools, cmd: string, args: string[], opts: ExecOptions): ExecResult {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...tools.env },
    encoding: 'utf8',
    shell: win,
    stdio: [opts.noStdin ? 'ignore' : 'inherit', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const out = { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  if (!opts.capture && out.stdout) process.stdout.write(tools.redact(out.stdout));
  if (out.stderr && (out.status !== 0 || !opts.capture))
    process.stderr.write(tools.redact(out.stderr));
  return out;
}

export class CommandError extends Error {}

function wrangler(tools: Tools, args: string[], opts: Omit<ExecOptions, 'cwd'> = {}): ExecResult {
  return exec(tools, bin(tools.apiDir, 'wrangler'), args, { cwd: tools.apiDir, ...opts });
}

function cf(tools: Tools, args: string[], opts: Omit<ExecOptions, 'cwd'> = {}): ExecResult {
  const setupDir = join(tools.repoRoot, 'scripts', 'setup');
  return exec(tools, bin(setupDir, 'cf'), args, { cwd: setupDir, ...opts });
}

function ok(r: ExecResult, what: string): ExecResult {
  if (r.status !== 0) throw new CommandError(`${what} failed (exit ${r.status})`);
  return r;
}

function json<T>(r: ExecResult, what: string): T {
  ok(r, what);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new CommandError(`${what} did not print JSON`);
  }
}

export interface Account {
  id: string;
  name: string;
}

export function whoami(tools: Tools): Account[] {
  const r = wrangler(tools, ['whoami', '--json'], { capture: true, noStdin: true });
  if (r.status !== 0) {
    throw new CommandError(
      'wrangler is not logged in: run `pnpm --filter @openlive/api exec wrangler login`',
    );
  }
  const info = JSON.parse(r.stdout) as { loggedIn?: boolean; accounts?: Account[] };
  if (!info.loggedIn) throw new CommandError('wrangler is not logged in');
  return info.accounts ?? [];
}

/**
 * The token wrangler signs in with, for the read-only API calls of the checks (zones, the
 * workers.dev subdomain, R2). Captured, never shown; the caller adds it to the redactor.
 */
export function authToken(tools: Tools): string {
  const r = wrangler(tools, ['auth', 'token', '--json'], { capture: true, noStdin: true });
  if (r.status === 0) {
    try {
      const out = JSON.parse(r.stdout) as { token?: string };
      if (out.token) return out.token;
    } catch {
      // Fall through to the environment.
    }
  }
  const fromEnv = process.env['CLOUDFLARE_API_TOKEN'];
  if (fromEnv) return fromEnv;
  throw new CommandError('could not read the wrangler login token (`wrangler auth token`)');
}

export function pnpmVersion(repoRoot: string): string | null {
  const r = spawnSync(win ? 'pnpm.cmd' : 'pnpm', ['--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: win,
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function cfLoggedIn(tools: Tools): boolean {
  return cf(tools, ['auth', 'whoami'], { capture: true, noStdin: true }).status === 0;
}

export function d1DatabaseId(tools: Tools, name: string): string | null {
  const list = json<{ uuid: string; name: string }[]>(
    wrangler(tools, ['d1', 'list', '--json'], { capture: true, noStdin: true }),
    'wrangler d1 list',
  );
  return list.find((d) => d.name === name)?.uuid ?? null;
}

export function d1Create(tools: Tools, name: string): string {
  ok(wrangler(tools, ['d1', 'create', name], { noStdin: true }), `wrangler d1 create ${name}`);
  const id = d1DatabaseId(tools, name);
  if (!id) throw new CommandError(`D1 database ${name} was created but is not listed`);
  return id;
}

export function r2BucketExists(tools: Tools, name: string): boolean {
  const r = wrangler(tools, ['r2', 'bucket', 'info', name, '--json'], {
    capture: true,
    noStdin: true,
  });
  if (r.status === 0) return true;
  if (/not exist|10006|not found/i.test(r.stderr + r.stdout)) return false;
  throw new CommandError(`wrangler r2 bucket info ${name} failed (is R2 enabled on the account?)`);
}

/** New buckets are private: no public r2.dev URL and no custom domain unless added later. */
export function r2Create(tools: Tools, name: string): void {
  ok(
    wrangler(tools, ['r2', 'bucket', 'create', name], { noStdin: true }),
    `wrangler r2 bucket create ${name}`,
  );
}

/** Secret names on the deployed Worker, or null when the Worker doesn't exist yet. */
export function workerSecretNames(tools: Tools, workerName: string): string[] | null {
  const r = wrangler(tools, ['secret', 'list', '--name', workerName, '--format', 'json'], {
    capture: true,
    noStdin: true,
  });
  if (r.status !== 0) {
    if (/10007|not found|does not exist/i.test(r.stderr + r.stdout)) return null;
    throw new CommandError('wrangler secret list failed');
  }
  return (JSON.parse(r.stdout) as { name: string }[]).map((s) => s.name);
}

export function realtimeNames(tools: Tools, kind: 'sfu' | 'turn'): string[] {
  const args =
    kind === 'sfu' ? ['realtime', 'sfu', 'apps', 'list'] : ['realtime', 'turn', 'keys', 'list'];
  const list = json<{ name?: string }[]>(
    cf(tools, args, { capture: true, noStdin: true }),
    `cf ${args.join(' ')}`,
  );
  return list.map((x) => x.name ?? '');
}

/** Creates the SFU app or TURN key. The output holds the token, so it is captured, never shown. */
export function realtimeCreate(
  tools: Tools,
  kind: 'sfu' | 'turn',
  name: string,
): { id: string; token: string } {
  const args =
    kind === 'sfu'
      ? ['realtime', 'sfu', 'apps', 'create', '--name', name]
      : ['realtime', 'turn', 'keys', 'create', '--name', name];
  const what = `cf ${args.slice(0, 4).join(' ')}`;
  // Both the SFU app and the TURN key return their token as `secret` (checked with cf 0.15).
  const created = json<{ uid?: string; secret?: string }>(
    cf(tools, args, { capture: true, noStdin: true }),
    what,
  );
  const token = created.secret;
  if (!created.uid || !token) throw new CommandError(`${what} returned no id or token`);
  return { id: created.uid, token };
}

export function buildWeb(tools: Tools): void {
  ok(
    exec(tools, win ? 'pnpm.cmd' : 'pnpm', ['--filter', '@openlive/web', 'build'], {
      cwd: tools.repoRoot,
      noStdin: true,
    }),
    'pnpm --filter @openlive/web build',
  );
}

export function applyMigrations(
  tools: Tools,
  configPath: string,
  env: string,
  binding: string,
): void {
  // Without a terminal on stdin wrangler skips its own prompt; the setup already asked.
  ok(
    wrangler(
      tools,
      ['d1', 'migrations', 'apply', binding, '--remote', '--config', configPath, '--env', env],
      {
        noStdin: true,
      },
    ),
    'wrangler d1 migrations apply',
  );
}

/**
 * Deploys code and secrets as one version. Returns the result instead of throwing, so the caller
 * can recognize a failure it can work around (Analytics Engine not enabled).
 */
export function deploy(
  tools: Tools,
  configPath: string,
  env: string,
  secretsJsonPath: string,
): ExecResult {
  return wrangler(
    tools,
    ['deploy', '--config', configPath, '--env', env, '--secrets-file', secretsJsonPath],
    { noStdin: true },
  );
}
