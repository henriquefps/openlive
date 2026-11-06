// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  androidApkUrl,
  compareVersions,
  parseManifest,
  pickUpdate,
  readDismissed,
  shouldShowUpdate,
  sizeInMb,
} from '../src/lib/app-update.ts';

const manifest = (version: string) => ({
  schema: 1,
  version,
  url: androidApkUrl(version),
  size: 50 * 1024 * 1024,
});

describe('compareVersions', () => {
  it('orders major, minor and patch', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.1.2', '1.1.1')).toBeGreaterThan(0);
    expect(compareVersions('1.1.1', '1.1.1')).toBe(0);
    expect(compareVersions('0.1.4', '0.1.5')).toBeLessThan(0);
  });
  it('compares numbers, not text: 0.1.10 > 0.1.9', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
  });
  it('is null for anything but X.Y.Z', () => {
    expect(compareVersions('1.0', '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', '')).toBeNull();
  });
});

describe('pickUpdate', () => {
  it('is null when equal or older', () => {
    expect(pickUpdate('0.1.5', [{ origin: 'https://a', manifest: manifest('0.1.5') }])).toBeNull();
    expect(pickUpdate('0.1.5', [{ origin: 'https://a', manifest: manifest('0.1.4') }])).toBeNull();
  });
  it('finds a newer version', () => {
    expect(
      pickUpdate('0.1.9', [{ origin: 'https://a', manifest: manifest('0.1.10') }])?.version,
    ).toBe('0.1.10');
  });
  it('ignores invalid manifests', () => {
    const offers = [
      { origin: 'https://a', manifest: null },
      { origin: 'https://b', manifest: { version: 'latest', url: 'https://x' } },
      { origin: 'https://c', manifest: { version: '9.9.9', url: 'http://insecure' } },
      { origin: 'https://d', manifest: { ...manifest('1.0.0-rc1') } },
    ];
    expect(pickUpdate('0.1.5', offers)).toBeNull();
  });
  it('picks the highest across servers and says which', () => {
    const picked = pickUpdate('0.1.5', [
      { origin: 'https://a', manifest: manifest('0.2.0') },
      { origin: 'https://b', manifest: manifest('0.10.0') },
      { origin: 'https://c', manifest: manifest('0.3.0') },
    ]);
    expect(picked?.version).toBe('0.10.0');
    expect(picked?.origin).toBe('https://b');
  });
  it('shows nothing when the installed version is not valid', () => {
    expect(pickUpdate('', [{ origin: 'https://a', manifest: manifest('1.0.0') }])).toBeNull();
  });
});

describe('shouldShowUpdate and dismissal', () => {
  const update = pickUpdate('0.1.5', [{ origin: 'https://a', manifest: manifest('0.2.0') }]);
  it('shows a newer version that was not dismissed', () => {
    expect(shouldShowUpdate(update, null)).toBe(true);
  });
  it('hides the dismissed version but shows a newer one again', () => {
    expect(shouldShowUpdate(update, '0.2.0')).toBe(false);
    const newer = pickUpdate('0.1.5', [{ origin: 'https://a', manifest: manifest('0.2.1') }]);
    expect(shouldShowUpdate(newer, '0.2.0')).toBe(true);
  });
  it('shows nothing without an update', () => {
    expect(shouldShowUpdate(null, null)).toBe(false);
  });
  it('ignores an invalid saved value', () => {
    expect(readDismissed('0.2.0')).toBe('0.2.0');
    expect(readDismissed('junk')).toBeNull();
    expect(readDismissed(null)).toBeNull();
  });
});

describe('sizeInMb', () => {
  it('formats and handles unknown', () => {
    expect(sizeInMb(50_000_000)).toBe('50.0');
    expect(sizeInMb(73_191_086)).toBe('73.2');
    expect(sizeInMb(0)).toBeNull();
  });
});

describe('parseManifest url', () => {
  const good = androidApkUrl('1.2.3');
  const ok = (url: string, version = '1.2.3') => parseManifest({ version, url, size: 1 }) !== null;
  it('accepts exactly the official APK link', () => {
    expect(ok(good)).toBe(true);
    expect(good).toBe(
      'https://github.com/henriquefps/openlive/releases/download/android-v1.2.3/openlive-1.2.3-android.apk',
    );
  });
  it.each([
    [
      'other host',
      'https://example.com/henriquefps/openlive/releases/download/android-v1.2.3/openlive-1.2.3-android.apk',
    ],
    [
      'other repo',
      'https://github.com/evil/openlive/releases/download/android-v1.2.3/openlive-1.2.3-android.apk',
    ],
    [
      'other tag',
      'https://github.com/henriquefps/openlive/releases/download/helper-v1.2.3/openlive-1.2.3-android.apk',
    ],
    [
      'other name',
      'https://github.com/henriquefps/openlive/releases/download/android-v1.2.3/evil.apk',
    ],
    ['query', `${good}?x=1`],
    ['fragment', `${good}#x`],
    ['http', good.replace('https:', 'http:')],
    ['port', good.replace('github.com', 'github.com:8443')],
    ['look-alike host', good.replace('github.com', 'github.com.evil.example')],
    [
      'userinfo trick',
      good.replace('https://github.com', ['https://github.com', 'evil.example'].join('@')),
    ],
    ['credentials', good.replace('https://', 'https://user:pw@')],
    ['trailing slash', `${good}/`],
  ])('rejects %s', (_name, url) => {
    expect(ok(url)).toBe(false);
  });
  it('rejects a version that differs from the one in the url', () => {
    expect(ok(good, '1.2.4')).toBe(false);
    expect(ok(androidApkUrl('1.2.4'), '1.2.3')).toBe(false);
  });
});
