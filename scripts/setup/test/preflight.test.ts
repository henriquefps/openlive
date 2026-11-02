// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  atLeast,
  checkAddress,
  checkCf,
  checkDeps,
  checkNode,
  checkPnpm,
  checkR2,
  checkWrangler,
  failed,
  formatChecks,
} from '../src/preflight.ts';

const domain = { kind: 'custom_domain' as const, domain: 'live.example.com' };

describe('versions', () => {
  it('compares numerically', () => {
    expect(atLeast('26.12.1', '26')).toBe(true);
    expect(atLeast('v26.0.0', '26')).toBe(true);
    expect(atLeast('25.9.0', '26')).toBe(false);
    expect(atLeast('12.15.0', '12.15.0')).toBe(true);
    expect(atLeast('12.9.0', '12.15.0')).toBe(false);
    expect(atLeast('13.0.0', '12.15.0')).toBe(true);
  });

  it('Node and pnpm checks carry their fixes', () => {
    expect(checkNode('26.12.1', '26').status).toBe('ok');
    expect(checkNode('22.1.0', '26')).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/Node 26/),
    });
    expect(checkPnpm(null, '12.15.0')).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/corepack enable/),
    });
    expect(checkPnpm('11.0.0', '12.15.0').status).toBe('fail');
    expect(checkPnpm('12.15.0', '12.15.0').status).toBe('ok');
    expect(checkDeps(false)).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/pnpm install/),
    });
  });
});

describe('logins', () => {
  it('wrangler: skipped in a dry run, failing with the login command', () => {
    expect(checkWrangler(null).status).toBe('skip');
    expect(checkWrangler({ ok: false, error: 'not logged in' })).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/wrangler login/),
    });
    expect(checkWrangler({ ok: true, value: { accounts: 1 } }).status).toBe('ok');
  });

  it('cf: only needed while a Realtime resource is missing', () => {
    expect(checkCf({ ok: false, error: 'x' }, false).status).toBe('skip');
    expect(checkCf({ ok: false, error: 'x' }, true)).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/cf auth login/),
    });
  });
});

describe('R2', () => {
  it('not enabled: fails with the card note', () => {
    expect(checkR2({ ok: true, value: 'not_enabled' })).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/payment method/),
    });
    expect(checkR2({ ok: true, value: 'enabled' }).status).toBe('ok');
    expect(checkR2(null).detail).toMatch(/payment method/);
    expect(checkR2({ ok: false, error: 'HTTP 500' }).status).toBe('warn');
  });
});

describe('address', () => {
  it('custom domain: active zone, missing zone, pending zone', () => {
    const zone = { id: 'z', name: 'example.com', status: 'active' };
    expect(checkAddress(domain, { ok: true, value: [zone] }, null).status).toBe('ok');
    expect(checkAddress(domain, { ok: true, value: [] }, null)).toMatchObject({
      status: 'fail',
      detail: 'no zone in this account',
    });
    expect(
      checkAddress(domain, { ok: true, value: [{ ...zone, status: 'pending' }] }, null).detail,
    ).toBe('example.com is pending');
    expect(checkAddress(domain, null, null).status).toBe('skip');
  });

  it('workers.dev: the account subdomain must exist', () => {
    const wd = { kind: 'workers_dev' as const };
    expect(checkAddress(wd, null, { ok: true, value: 'acme' })).toMatchObject({
      status: 'ok',
      detail: 'acme.workers.dev',
    });
    expect(checkAddress(wd, null, { ok: true, value: null })).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/Workers & Pages/),
    });
  });
});

describe('formatChecks', () => {
  it('shows fixes only for what is not ok', () => {
    const checks = [checkNode('26.1.0', '26'), checkDeps(false)];
    const text = formatChecks(checks);
    expect(text).toContain('[ok] Node.js');
    expect(text).toContain('[XX] Dependencies');
    expect(text).toContain('fix: run `pnpm install` once');
    expect(failed(checks)).toHaveLength(1);
  });
});
