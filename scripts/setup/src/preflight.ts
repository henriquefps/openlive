// SPDX-License-Identifier: AGPL-3.0-only
// The checks before the setup changes anything, each with the fix to apply. The probes (running
// the CLIs, calling the API) happen in main.ts; this file turns their results into checks.

import type { R2State } from './api.ts';
import { resolveZone, type Route, type Zone } from './domain.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What to do when it is not ok. */
  fix?: string;
}

const check = (
  id: string,
  title: string,
  status: CheckStatus,
  detail: string,
  fix?: string,
): Check =>
  fix === undefined ? { id, title, status, detail } : { id, title, status, detail, fix };

/** `26.12.0` ≥ `26` / `12.15` style comparison on the numeric parts. */
export function atLeast(version: string, minimum: string): boolean {
  const a = version.replace(/^v/, '').split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

export function checkNode(version: string, minimum: string): Check {
  return atLeast(version, minimum)
    ? check('node', 'Node.js', 'ok', version)
    : check(
        'node',
        'Node.js',
        'fail',
        `${version}, needs ${minimum} or newer`,
        `install Node ${minimum} (https://nodejs.org, or your version manager)`,
      );
}

/** `packageManager` pins the exact pnpm; a newer major may change the lockfile. */
export function checkPnpm(version: string | null, wanted: string): Check {
  if (version === null) {
    return check('pnpm', 'pnpm', 'fail', 'not found', `run \`corepack enable\` (pnpm ${wanted})`);
  }
  if (!atLeast(version, wanted)) {
    return check(
      'pnpm',
      'pnpm',
      'fail',
      `${version}, needs ${wanted}`,
      '`corepack enable`, then run the setup again in the repository',
    );
  }
  return check('pnpm', 'pnpm', 'ok', version);
}

export function checkDeps(installed: boolean): Check {
  return installed
    ? check('deps', 'Dependencies', 'ok', 'installed')
    : check('deps', 'Dependencies', 'fail', 'not installed', 'run `pnpm install` once');
}

export type Probe<T> = { ok: true; value: T } | { ok: false; error: string };

export function checkWrangler(p: Probe<{ accounts: number }> | null): Check {
  const title = 'wrangler login';
  if (!p) return check('wrangler', title, 'skip', 'not checked (dry run)');
  if (!p.ok) {
    return check(
      'wrangler',
      title,
      'fail',
      p.error,
      'run `pnpm --filter @openlive/api exec wrangler login`',
    );
  }
  return check('wrangler', title, 'ok', `${p.value.accounts} account(s)`);
}

/** The cf login is only needed while a Realtime app or TURN key is still to be created. */
export function checkCf(p: Probe<true> | null, needed: boolean): Check {
  const title = 'cf login (Realtime)';
  if (!needed) return check('cf', title, 'skip', 'not needed: Realtime app and TURN key exist');
  if (!p) return check('cf', title, 'skip', 'not checked (dry run)');
  if (!p.ok) {
    return check(
      'cf',
      title,
      'fail',
      p.error,
      'run `pnpm --filter @openlive/setup exec cf auth login`',
    );
  }
  return check('cf', title, 'ok', 'logged in');
}

export function checkR2(p: Probe<R2State> | null): Check {
  const title = 'R2 enabled';
  const card = 'R2 asks for a payment method once; it stays free within its free tier';
  if (!p) return check('r2', title, 'skip', `not checked (dry run). ${card}`);
  if (!p.ok) return check('r2', title, 'warn', `could not check: ${p.error}`);
  if (p.value === 'enabled') return check('r2', title, 'ok', 'enabled');
  return check(
    'r2',
    title,
    'fail',
    'R2 is not enabled on this account',
    `dashboard → R2 Object Storage → enable it (${card}), then run the setup again`,
  );
}

export function checkAddress(
  route: Route,
  zones: Probe<Zone[]> | null,
  subdomain: Probe<string | null> | null,
): Check {
  if (route.kind === 'custom_domain') {
    const title = `Zone for ${route.domain}`;
    if (!zones) return check('zone', title, 'skip', 'not checked (dry run)');
    if (!zones.ok)
      return check(
        'zone',
        title,
        'fail',
        zones.error,
        'run the setup again (the API may be briefly down)',
      );
    const z = resolveZone(route.domain, zones.value);
    if (z.ok) return check('zone', title, 'ok', `${z.zone.name} is active`);
    return check(
      'zone',
      title,
      'fail',
      z.reason === 'not_found' ? 'no zone in this account' : `${z.zone?.name} is ${z.zone?.status}`,
      z.fix,
    );
  }
  const title = 'workers.dev subdomain';
  if (!subdomain) return check('subdomain', title, 'skip', 'not checked (dry run)');
  if (!subdomain.ok)
    return check('subdomain', title, 'fail', subdomain.error, 'run the setup again');
  if (!subdomain.value) {
    return check(
      'subdomain',
      title,
      'fail',
      'the account has no workers.dev subdomain yet',
      'dashboard → Workers & Pages → pick your workers.dev subdomain once, then run the setup again',
    );
  }
  return check('subdomain', title, 'ok', `${subdomain.value}.workers.dev`);
}

export const failed = (checks: readonly Check[]) => checks.filter((c) => c.status === 'fail');

const MARK: Record<CheckStatus, string> = { ok: 'ok', warn: '!!', fail: 'XX', skip: '--' };

export function formatChecks(checks: readonly Check[]): string {
  const lines = ['Checks:'];
  for (const c of checks) {
    lines.push(`  [${MARK[c.status]}] ${c.title}: ${c.detail}`);
    if (c.fix && c.status !== 'ok') lines.push(`       fix: ${c.fix}`);
  }
  return lines.join('\n');
}
