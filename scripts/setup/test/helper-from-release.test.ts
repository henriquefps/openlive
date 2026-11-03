// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAndroidManifest, parseHelperManifest } from '../../../apps/api/src/helper/release.ts';
import {
  compareVersions,
  type Fetch,
  androidAsset,
  assetUrl,
  findRelease,
  type GitHubRelease,
  parseSha256sums,
  publishFromRelease,
  releaseFiles,
} from '../src/helper-from-release.ts';
import { parsePublishArgs } from '../src/helper-release.ts';

const REPO = 'henriquefps/openlive';
const API = `https://api.github.com/repos/${REPO}`;
const DL = `https://github.com/${REPO}/releases/download/helper-v0.2.0`;
const ROOM_GO = `https://raw.githubusercontent.com/${REPO}/helper-v0.2.0/helper/internal/api/room.go`;

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const files = {
  'openlive-helper-0.2.0-linux-amd64.tar.gz': 'tarball bytes',
  'openlive-helper-0.2.0.flatpak': 'flatpak bytes!',
  'openlive-helper-0.2.0-macos.dmg': 'dmg',
};
const sums = (over: Record<string, string> = {}) =>
  Object.entries(files)
    .map(([n, body]) => `${over[n] ?? sha(body)}  ${n}\n`)
    .join('');

function release(over: Partial<GitHubRelease> = {}, names = Object.keys(files)): GitHubRelease {
  return {
    tag_name: 'helper-v0.2.0',
    html_url: `https://github.com/${REPO}/releases/tag/helper-v0.2.0`,
    draft: false,
    prerelease: false,
    published_at: '2026-11-02T10:00:00Z',
    assets: [
      ...names.map((name) => ({
        name,
        size: files[name as keyof typeof files].length,
        browser_download_url: `${DL}/${name}`,
      })),
      { name: 'SHA256SUMS', size: 10, browser_download_url: `${DL}/SHA256SUMS` },
      {
        name: 'openlive-helper-0.2.0.flatpak.sha256',
        size: 10,
        browser_download_url: `${DL}/openlive-helper-0.2.0.flatpak.sha256`,
      },
    ],
    ...over,
  };
}

/** A fetch that answers from a table and records every URL; anything else is a 404. */
function mockFetch(table: Record<string, unknown>) {
  const calls: string[] = [];
  const fetch: Fetch = async (url) => {
    calls.push(url);
    if (!(url in table)) return new Response('not found', { status: 404 });
    const v = table[url];
    if (v instanceof Response) return v;
    return new Response(typeof v === 'string' ? v : JSON.stringify(v), { status: 200 });
  };
  return { fetch, calls };
}

const ADL = `https://github.com/${REPO}/releases/download/android-v0.1.5`;
const APK = 'openlive-0.1.5-android.apk';
const apkSha = sha('apk bytes');
function androidRelease(over: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    tag_name: 'android-v0.1.5',
    html_url: `https://github.com/${REPO}/releases/tag/android-v0.1.5`,
    draft: false,
    prerelease: true,
    published_at: '2026-11-03T10:00:00Z',
    assets: [
      { name: APK, size: 9, browser_download_url: `${ADL}/${APK}` },
      { name: 'SHA256SUMS', size: 93, browser_download_url: `${ADL}/SHA256SUMS` },
    ],
    ...over,
  };
}

const room = 'ProtocolVersion = protocol.ProtocolVersion{Major: 1, Minor: 12}';
const table = (over: Record<string, unknown> = {}) => ({
  [`${API}/releases/tags/helper-v0.2.0`]: release(),
  [`${DL}/SHA256SUMS`]: sums(),
  [ROOM_GO]: room,
  [`${API}/releases/tags/android-v0.1.5`]: androidRelease(),
  [`${ADL}/SHA256SUMS`]: `${apkSha}  ${APK}\n`,
  ...over,
});

const facts = {
  bucketName: 'openlive-thumbnails',
  generatedConfig: 'apps/api/wrangler.production.generated.jsonc',
  instanceUrl: 'https://live.example.com',
};

const roots: string[] = [];
const newRoot = () => {
  const r = mkdtempSync(join(tmpdir(), 'helper-from-release-'));
  roots.push(r);
  return r;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function run(argv: string[], t: Record<string, unknown> = table()) {
  const { fetch, calls } = mockFetch(t);
  const uploads: string[][] = [];
  const log: string[] = [];
  const root = newRoot();
  const result = publishFromRelease(parsePublishArgs(argv), facts, {
    fetch,
    upload: (c) => uploads.push(c),
    log: (l) => log.push(l),
    root,
    now: () => new Date('2026-11-02T12:00:00Z'),
  });
  return { result, calls, uploads, log: () => log.join('\n'), root };
}

describe('parsePublishArgs with --from-release', () => {
  it('takes a version or latest, and the default repository', () => {
    expect(parsePublishArgs(['--from-release', 'helper-v0.2.0'])).toMatchObject({
      fromRelease: '0.2.0',
      releaseRepo: REPO,
      allowPrerelease: false,
    });
    expect(
      parsePublishArgs(['--from-release', 'latest', '--release-repo', 'me/fork']),
    ).toMatchObject({ fromRelease: 'latest', releaseRepo: 'me/fork' });
  });

  it('refuses the build flags with it, and its flags without it', () => {
    expect(() => parsePublishArgs(['--from-release', 'next'])).toThrow(/not a version/);
    for (const extra of [
      ['--version', '0.2.0'],
      ['--mac-dmg', 'openlive-helper-0.2.0-macos.dmg'],
      ['--skip-build'],
      ['--no-flatpak'],
    ]) {
      expect(() => parsePublishArgs(['--from-release', 'latest', ...extra])).toThrow(/leave out/);
    }
    expect(() => parsePublishArgs(['--release-repo', 'a/b'])).toThrow(/go with --from-release/);
    expect(() => parsePublishArgs(['--allow-prerelease'])).toThrow(/go with --from-release/);
    expect(parsePublishArgs(['--android-from-release', 'v0.1.5'])).toMatchObject({
      androidFromRelease: '0.1.5',
      fromRelease: undefined,
    });
    expect(
      parsePublishArgs(['--from-release', '0.1.4', '--android-from-release', '0.1.5']),
    ).toMatchObject({
      fromRelease: '0.1.4',
      androidFromRelease: '0.1.5',
    });
    expect(() => parsePublishArgs(['--android-from-release', 'latest'])).toThrow(/not a version/);
    expect(() => parsePublishArgs(['--android-from-release', '0.1.5', '--skip-build'])).toThrow(
      /leave out/,
    );
    expect(() => parsePublishArgs(['--from-release', 'latest', '--release-repo', 'x'])).toThrow(
      /owner\/name/,
    );
  });
});

describe('finding the release', () => {
  it('says clearly that a version has no published release', async () => {
    const { fetch } = mockFetch({});
    await expect(findRelease(fetch, REPO, '0.1.2', false)).rejects.toThrow(
      'github.com/henriquefps/openlive has no published release helper-v0.1.2',
    );
  });

  it('picks the highest published helper-v* release for latest', async () => {
    const list = [
      release({ tag_name: 'helper-v0.3.0', draft: true }),
      release({ tag_name: 'helper-v0.2.10-rc.1', prerelease: true }),
      release({ tag_name: 'v9.0.0' }),
      release({ tag_name: 'helper-v0.2.9' }),
      release({ tag_name: 'helper-v0.2.10' }),
    ];
    const { fetch } = mockFetch({ [`${API}/releases?per_page=100`]: list });
    expect((await findRelease(fetch, REPO, 'latest', false)).tag_name).toBe('helper-v0.2.10');
    const empty = mockFetch({ [`${API}/releases?per_page=100`]: [] });
    await expect(findRelease(empty.fetch, REPO, 'latest', false)).rejects.toThrow(
      /no published helper-v\* release yet/,
    );
  });

  it('refuses a prerelease without --allow-prerelease', async () => {
    const { fetch } = mockFetch({
      [`${API}/releases/tags/helper-v0.2.0`]: release({ prerelease: true }),
    });
    await expect(findRelease(fetch, REPO, '0.2.0', false)).rejects.toThrow(/--allow-prerelease/);
    expect((await findRelease(fetch, REPO, '0.2.0', true)).prerelease).toBe(true);
    const draft = mockFetch({ [`${API}/releases/tags/helper-v0.2.0`]: release({ draft: true }) });
    await expect(findRelease(draft.fetch, REPO, '0.2.0', true)).rejects.toThrow(/draft/);
  });

  it('explains the rate limit', async () => {
    const { fetch } = mockFetch({
      [`${API}/releases/tags/helper-v0.2.0`]: new Response('', { status: 403 }),
    });
    await expect(findRelease(fetch, REPO, '0.2.0', false)).rejects.toThrow(/rate limit/);
  });

  it('orders versions', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
  });
});

describe('the files of a release', () => {
  it('takes the helper files, with GitHub URLs, and needs SHA256SUMS and the tarball', () => {
    const r = releaseFiles(release(), REPO);
    expect(r.version).toBe('0.2.0');
    expect(r.files.map((f) => f.kind)).toEqual(['tarball', 'flatpak', 'dmg']);
    expect(r.files[0]?.url).toBe(`${DL}/openlive-helper-0.2.0-linux-amd64.tar.gz`);
    const linuxOnly = releaseFiles(release({}, ['openlive-helper-0.2.0-linux-amd64.tar.gz']), REPO);
    expect(linuxOnly.files.map((f) => f.kind)).toEqual(['tarball']);
    expect(() =>
      releaseFiles(
        release({ assets: release().assets.filter((a) => a.name !== 'SHA256SUMS') }),
        REPO,
      ),
    ).toThrow(/no SHA256SUMS/);
    expect(() => releaseFiles(release({}, ['openlive-helper-0.2.0.flatpak']), REPO)).toThrow(
      /no openlive-helper-0\.2\.0-linux-amd64\.tar\.gz/,
    );
  });

  it('builds the asset URL the Worker accepts', () => {
    expect(assetUrl(REPO, 'helper-v0.2.0', 'a.tar.gz')).toBe(`${DL}/a.tar.gz`);
  });

  it('takes the APK of an android release, and needs it and SHA256SUMS', () => {
    expect(androidAsset(androidRelease(), REPO)).toMatchObject({
      version: '0.1.5',
      name: APK,
      url: `${ADL}/${APK}`,
      size: 9,
    });
    expect(() => androidAsset(androidRelease({ assets: [] }), REPO)).toThrow(/no openlive-0\.1\.5/);
    expect(() =>
      androidAsset(androidRelease({ assets: androidRelease().assets.slice(0, 1) }), REPO),
    ).toThrow(/no SHA256SUMS/);
    expect(() => androidAsset(release(), REPO)).toThrow(/not an android-v/);
  });

  it('reads sha256sum output, text and binary mode', () => {
    const m = parseSha256sums(`${'A'.repeat(64)}  a.tar.gz\n${'b'.repeat(64)} *b.dmg\njunk\n`);
    expect([...m]).toEqual([
      ['a.tar.gz', 'a'.repeat(64)],
      ['b.dmg', 'b'.repeat(64)],
    ]);
  });
});

describe('publishFromRelease', () => {
  it('dry run: prints the plan from the release metadata, stages and uploads nothing', async () => {
    const r = await run([
      '--from-release',
      '0.2.0',
      '--android-from-release',
      '0.1.5',
      '--dry-run',
    ]);
    await r.result;
    expect(r.uploads).toEqual([]);
    expect(
      r.calls.filter((u) => u.endsWith('.tar.gz') || u.endsWith('.dmg') || u.endsWith('.apk')),
    ).toEqual([]);
    expect(existsSync(join(r.root, 'build'))).toBe(false);
    const text = r.log();
    expect(text).toContain(
      'Point https://live.example.com at the public releases of github.com/henriquefps/openlive',
    );
    expect(text).toContain(`${DL}/openlive-helper-0.2.0-macos.dmg`);
    expect(text).toContain(`sha256 ${sha('dmg')}`);
    expect(text).toContain('Protocol 1.12');
    expect(text).toContain(`${ADL}/${APK}`);
    expect(text).toContain(`sha256 ${apkSha}`);
    expect(text).toContain('helper/latest.json');
    expect(text).toContain('helper/android.json');
    expect(text).toContain('Dry run: nothing was staged or uploaded.');
  });

  it('uploads only the two manifests, in the Worker format, with GitHub URLs and no binary', async () => {
    const r = await run(['--from-release', '0.2.0', '--android-from-release', '0.1.5']);
    await r.result;
    expect(r.uploads.map((c) => c[4])).toEqual([
      'openlive-thumbnails/helper/latest.json',
      'openlive-thumbnails/helper/android.json',
    ]);
    expect(r.uploads[0]).toEqual([
      'wrangler',
      'r2',
      'object',
      'put',
      'openlive-thumbnails/helper/latest.json',
      '--file',
      '../../build/helper-publish/0.2.0/latest.json',
      '--content-type',
      'application/json',
      '--remote',
      '--config',
      'wrangler.production.generated.jsonc',
      '--env',
      'production',
    ]);
    expect(r.calls.some((u) => /\.(tar\.gz|flatpak|dmg|apk)$/.test(u))).toBe(false);
    const manifest = parseHelperManifest(
      readFileSync(join(r.root, 'build/helper-publish/0.2.0/latest.json'), 'utf8'),
    );
    expect(manifest).not.toBeNull();
    expect(manifest?.protocol).toEqual({ major: 1, minor: 12 });
    expect(manifest?.releaseNotesUrl).toBe(
      'https://github.com/henriquefps/openlive/releases/tag/helper-v0.2.0',
    );
    expect(manifest?.files.map((f) => [f.kind, f.size, f.sha256, f.url])).toEqual([
      [
        'tarball',
        13,
        sha(files['openlive-helper-0.2.0-linux-amd64.tar.gz']),
        `${DL}/openlive-helper-0.2.0-linux-amd64.tar.gz`,
      ],
      [
        'flatpak',
        14,
        sha(files['openlive-helper-0.2.0.flatpak']),
        `${DL}/openlive-helper-0.2.0.flatpak`,
      ],
      [
        'dmg',
        3,
        sha(files['openlive-helper-0.2.0-macos.dmg']),
        `${DL}/openlive-helper-0.2.0-macos.dmg`,
      ],
    ]);
    const android = parseAndroidManifest(
      readFileSync(join(r.root, 'build/helper-publish/android-0.1.5/android.json'), 'utf8'),
    );
    expect(android).toMatchObject({
      version: '0.1.5',
      name: APK,
      size: 9,
      sha256: apkSha,
      url: `${ADL}/${APK}`,
    });
  });

  it('--android-from-release alone leaves the helper manifest alone', async () => {
    const r = await run(['--android-from-release', 'android-v0.1.5']);
    await r.result;
    expect(r.uploads.map((c) => c[4])).toEqual(['openlive-thumbnails/helper/android.json']);
    expect(r.calls.some((u) => u.includes('helper-v'))).toBe(false);
  });

  it('--from-release alone does not touch the Android entry', async () => {
    const r = await run(['--from-release', '0.2.0']);
    await r.result;
    expect(r.uploads.map((c) => c[4])).toEqual(['openlive-thumbnails/helper/latest.json']);
  });

  it('uses the repository given and the version latest resolves to', async () => {
    const other = 'me/fork';
    const odl = `https://github.com/${other}/releases/download/helper-v0.2.0`;
    const r = await run(
      ['--from-release', 'latest', '--release-repo', other],
      table({
        [`https://api.github.com/repos/${other}/releases?per_page=100`]: [release()],
        [`https://raw.githubusercontent.com/${other}/helper-v0.2.0/helper/internal/api/room.go`]:
          room,
      }),
    );
    await r.result;
    const manifest = parseHelperManifest(
      readFileSync(join(r.root, 'build/helper-publish/0.2.0/latest.json'), 'utf8'),
      other,
    );
    expect(manifest?.version).toBe('0.2.0');
    expect(manifest?.files[0]?.url).toBe(`${odl}/openlive-helper-0.2.0-linux-amd64.tar.gz`);
  });

  it('stops before any upload when SHA256SUMS does not list a file or the release is missing', async () => {
    const unlisted = await run(
      ['--from-release', '0.2.0'],
      table({ [`${DL}/SHA256SUMS`]: `${sha('dmg')}  openlive-helper-0.2.0-macos.dmg\n` }),
    );
    await expect(unlisted.result).rejects.toThrow(/does not list openlive-helper-0\.2\.0-linux/);
    expect(unlisted.uploads).toEqual([]);
    const noApk = await run(['--android-from-release', '0.1.4']);
    await expect(noApk.result).rejects.toThrow(/has no published release android-v0\.1\.4/);
    expect(noApk.uploads).toEqual([]);
    const badSum = await run(
      ['--from-release', '0.2.0', '--android-from-release', '0.1.5'],
      table({ [`${ADL}/SHA256SUMS`]: `${apkSha}  other.apk\n` }),
    );
    await expect(badSum.result).rejects.toThrow(/does not list openlive-0\.1\.5-android\.apk/);
    expect(badSum.uploads).toEqual([]);
  });
});
