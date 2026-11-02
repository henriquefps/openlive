// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  defaultEmailFrom,
  describeRoute,
  originOf,
  resolveZone,
  validHostname,
  validWorkerName,
  zoneCandidates,
} from '../src/domain.ts';

describe('zoneCandidates', () => {
  it('lists the parent names, longest first, down to the registrable pair', () => {
    expect(zoneCandidates('a.b.example.com')).toEqual([
      'a.b.example.com',
      'b.example.com',
      'example.com',
    ]);
    expect(zoneCandidates('example.com')).toEqual(['example.com']);
  });
});

describe('resolveZone', () => {
  const active = { id: 'z1', name: 'example.com', status: 'active' };

  it('finds the zone of a subdomain', () => {
    expect(resolveZone('live.example.com', [active])).toEqual({ ok: true, zone: active });
  });

  it('prefers the most specific zone (a delegated subdomain zone)', () => {
    const sub = { id: 'z2', name: 'live.example.com', status: 'active' };
    expect(resolveZone('a.live.example.com', [active, sub])).toEqual({ ok: true, zone: sub });
  });

  it('zone not found: says how to add it, or to use workers.dev', () => {
    const r = resolveZone('live.example.com', []);
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(!r.ok && r.fix).toMatch(/add example\.com to the account.*--workers-dev/);
  });

  it('zone pending: says to finish the nameserver change', () => {
    const r = resolveZone('live.example.com', [{ ...active, status: 'pending' }]);
    expect(r).toMatchObject({ ok: false, reason: 'not_active' });
    expect(!r.ok && r.fix).toMatch(/is pending.*nameservers/);
  });

  it('does not match a zone that only ends with the same letters', () => {
    expect(resolveZone('live.myexample.com', [active])).toMatchObject({ ok: false });
  });
});

describe('addresses', () => {
  it('builds origins for both kinds', () => {
    expect(originOf({ kind: 'custom_domain', domain: 'live.example.com' }, 'openlive')).toBe(
      'https://live.example.com',
    );
    expect(originOf({ kind: 'workers_dev', subdomain: 'acme' }, 'openlive-test')).toBe(
      'https://openlive-test.acme.workers.dev',
    );
    expect(describeRoute({ kind: 'workers_dev' }, 'w')).toMatch(
      /w\.your-subdomain\.workers\.dev.*looked up/,
    );
  });

  it('defaults the sender only for a custom domain', () => {
    expect(defaultEmailFrom({ kind: 'custom_domain', domain: 'live.example.com' })).toBe(
      'Openlive <login@live.example.com>',
    );
    expect(defaultEmailFrom({ kind: 'workers_dev' })).toBeNull();
  });

  it('validates names', () => {
    expect(validHostname('live.example.com')).toBe(true);
    expect(validHostname('example')).toBe(false);
    expect(validHostname('1.2.3.4')).toBe(false);
    expect(validHostname('bad_.example.com')).toBe(false);
    expect(validWorkerName('openlive-test')).toBe(true);
    expect(validWorkerName('-x')).toBe(false);
    expect(validWorkerName('x'.repeat(64))).toBe(false);
  });
});
