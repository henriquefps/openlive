// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseHelperManifest } from '../../../apps/api/src/helper/release.ts';
import {
  compareVersions,
  type Fetch,
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

const room = 'ProtocolVersion = protocol.ProtocolVersion{Major: 1, Minor: 12}';
const table = (over: Record<string, unknown> = {}) => ({
  [`${API}/releases/tags/helper-v0.2.0`]: release(),
  [`${DL}/SHA256SUMS`]: sums(),
  [ROOM_GO]: room,
  ...Object.fromEntries(Object.entries(files).map(([n, body]) => [`${DL}/${n}`, body])),
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

async function run(argv: string[], t = table()) {
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
  it('takes the helper files in upload order and needs SHA256SUMS and the tarball', () => {
    const r = releaseFiles(release());
    expect(r.version).toBe('0.2.0');
    expect(r.files.map((f) => f.kind)).toEqual(['tarball', 'flatpak', 'dmg']);
    expect(r.files[0]?.path).toBe(
      'build/helper-publish/0.2.0/release/openlive-helper-0.2.0-linux-amd64.tar.gz',
    );
    const linuxOnly = releaseFiles(release({}, ['openlive-helper-0.2.0-linux-amd64.tar.gz']));
    expect(linuxOnly.files.map((f) => f.kind)).toEqual(['tarball']);
    expect(() =>
      releaseFiles(release({ assets: release().assets.filter((a) => a.name !== 'SHA256SUMS') })),
    ).toThrow(/no SHA256SUMS/);
    expect(() => releaseFiles(release({}, ['openlive-helper-0.2.0.flatpak']))).toThrow(
      /no openlive-helper-0\.2\.0-linux-amd64\.tar\.gz/,
    );
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
  it('dry run: prints the plan from the release metadata, downloads no helper file', async () => {
    const r = await run(['--from-release', '0.2.0', '--dry-run']);
    await r.result;
    expect(r.uploads).toEqual([]);
    expect(r.calls.filter((u) => u.endsWith('.tar.gz') || u.endsWith('.dmg'))).toEqual([]);
    const text = r.log();
    expect(text).toContain(
      'Publish openlive-helper 0.2.0 from the release helper-v0.2.0 of github.com/henriquefps/openlive to https://live.example.com',
    );
    expect(text).toContain('openlive-helper-0.2.0-macos.dmg (dmg,');
    expect(text).toContain('protocol 1.12');
    expect(text.indexOf('helper/latest.json')).toBeGreaterThan(
      text.indexOf('helper/0.2.0/SHA256SUMS'),
    );
    expect(text).toContain('Dry run: nothing was downloaded or uploaded.');
  });

  it('downloads, checks and uploads every file, latest.json last, in the Worker format', async () => {
    const r = await run(['--from-release', '0.2.0']);
    await r.result;
    expect(r.uploads.map((c) => c[4])).toEqual([
      'openlive-thumbnails/helper/0.2.0/openlive-helper-0.2.0-linux-amd64.tar.gz',
      'openlive-thumbnails/helper/0.2.0/openlive-helper-0.2.0.flatpak',
      'openlive-thumbnails/helper/0.2.0/openlive-helper-0.2.0-macos.dmg',
      'openlive-thumbnails/helper/0.2.0/SHA256SUMS',
      'openlive-thumbnails/helper/latest.json',
    ]);
    expect(r.uploads[0]).toEqual([
      'wrangler',
      'r2',
      'object',
      'put',
      'openlive-thumbnails/helper/0.2.0/openlive-helper-0.2.0-linux-amd64.tar.gz',
      '--file',
      '../../build/helper-publish/0.2.0/release/openlive-helper-0.2.0-linux-amd64.tar.gz',
      '--content-type',
      'application/gzip',
      '--remote',
      '--config',
      'wrangler.production.generated.jsonc',
      '--env',
      'production',
    ]);
    const staged = join(r.root, 'build/helper-publish/0.2.0');
    expect(readFileSync(join(staged, 'SHA256SUMS'), 'utf8')).toBe(sums());
    const manifest = parseHelperManifest(readFileSync(join(staged, 'latest.json'), 'utf8'));
    expect(manifest?.protocol).toEqual({ major: 1, minor: 12 });
    expect(manifest?.releaseNotesUrl).toBe(
      'https://github.com/henriquefps/openlive/releases/tag/helper-v0.2.0',
    );
    expect(manifest?.files.map((f) => [f.kind, f.os, f.arch, f.size, f.sha256])).toEqual([
      ['tarball', 'linux', 'amd64', 13, sha(files['openlive-helper-0.2.0-linux-amd64.tar.gz'])],
      ['flatpak', 'linux', 'amd64', 14, sha(files['openlive-helper-0.2.0.flatpak'])],
      ['dmg', 'macos', 'universal', 3, sha(files['openlive-helper-0.2.0-macos.dmg'])],
    ]);
  });

  it('aborts on a checksum mismatch before any upload', async () => {
    const r = await run(
      ['--from-release', '0.2.0'],
      table({
        [`${DL}/SHA256SUMS`]: sums({ 'openlive-helper-0.2.0-macos.dmg': 'f'.repeat(64) }),
      }),
    );
    await expect(r.result).rejects.toThrow(
      /openlive-helper-0\.2\.0-macos\.dmg does not match the release: SHA-256 .* Nothing was uploaded/,
    );
    expect(r.uploads).toEqual([]);
    expect(
      existsSync(
        join(r.root, 'build/helper-publish/0.2.0/release/openlive-helper-0.2.0-macos.dmg'),
      ),
    ).toBe(false);
  });

  it('aborts on a size mismatch, and on a file SHA256SUMS does not list', async () => {
    const short = await run(
      ['--from-release', '0.2.0'],
      table({ [`${DL}/openlive-helper-0.2.0.flatpak`]: 'flatpak' }),
    );
    await expect(short.result).rejects.toThrow(/bytes, GitHub lists 14/);
    expect(short.uploads).toEqual([]);
    const unlisted = await run(
      ['--from-release', '0.2.0', '--dry-run'],
      table({ [`${DL}/SHA256SUMS`]: `${sha('dmg')}  openlive-helper-0.2.0-macos.dmg\n` }),
    );
    await expect(unlisted.result).rejects.toThrow(/does not list openlive-helper-0\.2\.0-linux/);
  });
});
