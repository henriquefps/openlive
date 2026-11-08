// SPDX-License-Identifier: AGPL-3.0-only
import { type InstanceInfo, PROTOCOL_VERSION } from '@openlive/protocol';
import { describe, expect, it } from 'vitest';
import { ApiError, fetchInstanceInfo } from '../src/lib/api.ts';
import {
  APP_PROTOCOL,
  checkCompatibility,
  normalizeInstanceUrl,
  parseInstanceInfo,
} from '../src/lib/instance.ts';

const WELL_KNOWN = {
  name: 'openlive.example.com',
  iconUrl: 'https://openlive.example.com/icon-512.png',
  version: '0.1.3',
  commit: 'abc1234',
  protocol: { min: { major: 1, minor: 0 }, max: { major: 1, minor: 22 } },
  features: ['app_login', 'ws_ticket', 'invite_deep_link', 'capability:voice', 'future_thing'],
};

const info = (patch: Partial<InstanceInfo> = {}): InstanceInfo => ({
  ...(parseInstanceInfo(WELL_KNOWN) as InstanceInfo),
  ...patch,
});

describe('APP_PROTOCOL', () => {
  it('is the version of @openlive/protocol', () => {
    expect(APP_PROTOCOL).toEqual(PROTOCOL_VERSION);
  });
});

describe('normalizeInstanceUrl', () => {
  it('turns what people type into an origin', () => {
    expect(normalizeInstanceUrl('openlive.example.com')).toBe('https://openlive.example.com');
    expect(normalizeInstanceUrl('  https://openlive.example.com/  ')).toBe(
      'https://openlive.example.com',
    );
    expect(normalizeInstanceUrl('HTTPS://Openlive.Example.com:8443/invite/x?y#z')).toBe(
      'https://openlive.example.com:8443',
    );
  });

  it('allows plain http only on local addresses', () => {
    expect(normalizeInstanceUrl('http://openlive.example.com')).toBeNull();
    expect(normalizeInstanceUrl('http://192.168.1.20:8787')).toBe('http://192.168.1.20:8787');
    expect(normalizeInstanceUrl('http://localhost:8787')).toBe('http://localhost:8787');
  });

  it('rejects what is not an address', () => {
    for (const text of ['', '   ', 'hello', 'ftp://example.com', 'https://user:pw@example.com']) {
      expect(normalizeInstanceUrl(text)).toBeNull();
    }
  });
});

describe('parseInstanceInfo', () => {
  it('reads the well-known document', () => {
    expect(parseInstanceInfo(WELL_KNOWN)).toEqual(WELL_KNOWN);
  });

  it('drops an icon that is not an http(s) URL', () => {
    expect(parseInstanceInfo({ ...WELL_KNOWN, iconUrl: 'javascript:alert(1)' })).not.toHaveProperty(
      'iconUrl',
    );
  });

  it('rejects documents missing what the app reads', () => {
    for (const body of [
      null,
      'openlive',
      { ...WELL_KNOWN, name: ' ' },
      { ...WELL_KNOWN, protocol: { min: { major: 1 }, max: { major: 1, minor: 22 } } },
      { ...WELL_KNOWN, protocol: undefined },
      { ...WELL_KNOWN, features: 'app_login' },
      { ...WELL_KNOWN, features: [1] },
      { ...WELL_KNOWN, version: 3 },
    ]) {
      expect(parseInstanceInfo(body)).toBeNull();
    }
  });
});

describe('checkCompatibility', () => {
  const v = (major: number, minor = 0) => ({ major, minor });

  it('accepts an instance whose range holds the app major and offers the app login', () => {
    expect(checkCompatibility(info(), v(1, 20))).toEqual({ ok: true });
    // Minors do not matter: within a major, unknown fields are ignored.
    expect(checkCompatibility(info(), v(1, 40))).toEqual({ ok: true });
    expect(checkCompatibility(info({ protocol: { min: v(1), max: v(3) } }), v(2))).toEqual({
      ok: true,
    });
  });

  it('says which side must update', () => {
    expect(checkCompatibility(info(), v(2))).toEqual({ ok: false, reason: 'too_old' });
    expect(checkCompatibility(info({ protocol: { min: v(2), max: v(2) } }), v(1))).toEqual({
      ok: false,
      reason: 'too_new',
    });
  });

  it('needs the app_login feature', () => {
    expect(checkCompatibility(info({ features: ['ws_ticket'] }), v(1))).toEqual({
      ok: false,
      reason: 'no_app_login',
    });
  });
});

describe('fetchInstanceInfo', () => {
  const answer = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('fetches /.well-known/openlive.json of the origin', async () => {
    const urls: string[] = [];
    const result = await fetchInstanceInfo('https://openlive.example.com', async (url) => {
      urls.push(String(url));
      return answer(200, WELL_KNOWN)();
    });
    expect(urls).toEqual(['https://openlive.example.com/.well-known/openlive.json']);
    expect(result.name).toBe('openlive.example.com');
  });

  it('calls a 404 or a foreign document invalid_instance, and no answer network', async () => {
    const codeOf = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: unknown) => (e instanceof ApiError ? e.body.code : 'other'),
      );
    expect(await codeOf(fetchInstanceInfo('https://a.example.com', answer(404, {})))).toBe(
      'invalid_instance',
    );
    expect(await codeOf(fetchInstanceInfo('https://a.example.com', answer(200, { a: 1 })))).toBe(
      'invalid_instance',
    );
    expect(
      await codeOf(
        fetchInstanceInfo('https://a.example.com', async () => {
          throw new TypeError('Network request failed');
        }),
      ),
    ).toBe('network');
  });
});
