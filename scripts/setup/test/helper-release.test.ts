// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  helperFileKey,
  helperFileOf,
  LATEST_KEY as WORKER_LATEST_KEY,
  parseHelperManifest,
} from '../../../apps/api/src/helper/release.ts';
import {
  buildManifest,
  computePublishPlan,
  formatPublishPlan,
  helperProtocol,
  LATEST_KEY,
  objectKey,
  parsePublishArgs,
  type PublishFacts,
  sha256sums,
  uploadCommand,
  versionFromDescribe,
} from '../src/helper-release.ts';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

const facts = (over: Partial<PublishFacts> = {}): PublishFacts => ({
  version: '0.2.0',
  versionSource: 'flag',
  bucketName: 'openlive-thumbnails',
  generatedConfig: 'apps/api/wrangler.production.generated.jsonc',
  instanceUrl: 'https://live.example.com',
  flatpakBuilder: 'flatpak-app',
  runtimeVersion: '26.08',
  ...over,
});

describe('parsePublishArgs', () => {
  it('defaults to production and takes the pnpm separator', () => {
    expect(parsePublishArgs(['--', '--dry-run'])).toMatchObject({
      env: 'production',
      version: undefined,
      dryRun: true,
      skipBuild: false,
      noFlatpak: false,
      macDmg: undefined,
    });
    expect(parsePublishArgs(['--version', 'v0.2.0', '--env', 'friends']).version).toBe('0.2.0');
  });

  it('refuses a bad version, env, notes link or unknown flag', () => {
    expect(() => parsePublishArgs(['--version', '0.2'])).toThrow(/not a version/);
    expect(() => parsePublishArgs(['--env', 'dev'])).toThrow(/local only/);
    expect(() => parsePublishArgs(['--env', 'Prod'])).toThrow(/--env/);
    expect(() => parsePublishArgs(['--notes-url', 'http://x'])).toThrow(/https/);
    expect(() => parsePublishArgs(['--force'])).toThrow();
    expect(() => parsePublishArgs(['--mac-dmg', 'x.zip'])).toThrow(/-macos\.dmg/);
  });
});

describe('versions and protocol', () => {
  it('takes the version from a helper-v tag', () => {
    expect(versionFromDescribe('helper-v0.2.0\n')).toBe('0.2.0');
    expect(versionFromDescribe('helper-v0.2.0-3-gabc123')).toBe('0.2.0-3-gabc123');
    expect(versionFromDescribe('v1.0.0')).toBeNull();
    expect(versionFromDescribe('helper-vnext')).toBeNull();
  });

  it("reads the protocol from the helper's source", () => {
    const room = readFileSync(join(repoRoot, 'helper/internal/api/room.go'), 'utf8');
    expect(helperProtocol(room)).toEqual({ major: 1, minor: expect.any(Number) });
    expect(helperProtocol('package api')).toBeNull();
  });
});

describe('computePublishPlan (the dry run)', () => {
  it('builds both files, then uploads them, the checksums and latest.json last', () => {
    const args = parsePublishArgs(['--dry-run']);
    const plan = computePublishPlan(args, facts());
    expect(plan.files.map((f) => f.path)).toEqual([
      'dist/openlive-helper-0.2.0-linux-amd64.tar.gz',
      'dist/openlive-helper-0.2.0.flatpak',
    ]);
    expect(plan.build.map((s) => s.command[0])).toEqual([
      'packaging/linux/build-tarball-in-sdk.sh',
      'sh',
      'flatpak',
      'flatpak',
    ]);
    expect(plan.build[0]?.env).toEqual({ VERSION: '0.2.0' });
    expect(plan.uploads.map((u) => u.key)).toEqual([
      'helper/0.2.0/openlive-helper-0.2.0-linux-amd64.tar.gz',
      'helper/0.2.0/openlive-helper-0.2.0.flatpak',
      'helper/0.2.0/SHA256SUMS',
      'helper/latest.json',
    ]);
    expect(plan.uploads.at(-1)?.contentType).toBe('application/json');
  });

  it('leaves the Flatpak out without flatpak-builder or with --no-flatpak', () => {
    const none = computePublishPlan(parsePublishArgs([]), facts({ flatpakBuilder: null }));
    expect(none.files.map((f) => f.kind)).toEqual(['tarball']);
    expect(none.flatpakSkipped).toMatch(/not installed/);
    expect(none.uploads).toHaveLength(3);
    const flag = computePublishPlan(parsePublishArgs(['--no-flatpak']), facts());
    expect(flag.flatpakSkipped).toBe('--no-flatpak');
  });

  it('uses a flatpak-builder binary when that is what is installed', () => {
    const plan = computePublishPlan(parsePublishArgs([]), facts({ flatpakBuilder: 'binary' }));
    expect(plan.build.map((s) => s.command[0])).toContain('flatpak-builder');
  });

  it('builds nothing with --skip-build', () => {
    const plan = computePublishPlan(
      parsePublishArgs(['--skip-build']),
      facts({ flatpakBuilder: null }),
    );
    expect(plan.build).toEqual([]);
    expect(plan.files).toHaveLength(2);
  });

  it('adds the macOS disk image before the checksums, and only of this version', () => {
    const args = parsePublishArgs(['--mac-dmg', 'dist/openlive-helper-0.2.0-macos.dmg']);
    const plan = computePublishPlan(args, facts());
    expect(plan.files.at(-1)).toEqual({
      name: 'openlive-helper-0.2.0-macos.dmg',
      kind: 'dmg',
      path: 'dist/openlive-helper-0.2.0-macos.dmg',
    });
    expect(plan.uploads.map((u) => u.key).slice(-3)).toEqual([
      'helper/0.2.0/openlive-helper-0.2.0-macos.dmg',
      'helper/0.2.0/SHA256SUMS',
      'helper/latest.json',
    ]);
    expect(plan.uploads.at(-3)?.contentType).toBe('application/x-apple-diskimage');
    expect(formatPublishPlan(args, facts(), plan)).toContain(
      'macOS: dist/openlive-helper-0.2.0-macos.dmg, as built, signed, notarized and stapled',
    );
    expect(() =>
      computePublishPlan(
        parsePublishArgs(['--mac-dmg', 'openlive-helper-0.1.0-macos.dmg']),
        facts(),
      ),
    ).toThrow(/this release is openlive-helper-0\.2\.0-macos\.dmg/);
    const abs = computePublishPlan(
      parsePublishArgs(['--mac-dmg', '/srv/release/openlive-helper-0.2.0-macos.dmg']),
      facts(),
    ).uploads.at(-3);
    expect(abs && uploadCommand('b', 'production', abs)).toContain(
      '/srv/release/openlive-helper-0.2.0-macos.dmg',
    );
    expect(
      formatPublishPlan(
        parsePublishArgs([]),
        facts(),
        computePublishPlan(parsePublishArgs([]), facts()),
      ),
    ).toContain('macOS: none');
  });

  it('uploads with the pinned wrangler, the generated config and --remote', () => {
    const [first] = computePublishPlan(parsePublishArgs([]), facts()).uploads;
    expect(first && uploadCommand('openlive-thumbnails', 'production', first)).toEqual([
      'wrangler',
      'r2',
      'object',
      'put',
      'openlive-thumbnails/helper/0.2.0/openlive-helper-0.2.0-linux-amd64.tar.gz',
      '--file',
      '../../dist/openlive-helper-0.2.0-linux-amd64.tar.gz',
      '--content-type',
      'application/gzip',
      '--remote',
      '--config',
      'wrangler.production.generated.jsonc',
      '--env',
      'production',
    ]);
  });

  it('prints the plan', () => {
    const args = parsePublishArgs(['--dry-run']);
    const text = formatPublishPlan(args, facts(), computePublishPlan(args, facts()));
    expect(text).toContain('Publish openlive-helper 0.2.0 (--version) to https://live.example.com');
    expect(text).toContain('VERSION=0.2.0 packaging/linux/build-tarball-in-sdk.sh');
    expect(text).toContain(
      'wrangler r2 object put openlive-thumbnails/helper/latest.json --file ../../build/helper-publish/0.2.0/latest.json',
    );
    expect(text.indexOf('helper/latest.json')).toBeGreaterThan(text.indexOf('SHA256SUMS'));
  });
});

describe('the files it writes', () => {
  const files = [
    {
      name: 'openlive-helper-0.2.0-linux-amd64.tar.gz',
      kind: 'tarball',
      size: 9,
      sha256: 'a'.repeat(64),
    },
    { name: 'openlive-helper-0.2.0.flatpak', kind: 'flatpak', size: 7, sha256: 'b'.repeat(64) },
    { name: 'openlive-helper-0.2.0-macos.dmg', kind: 'dmg', size: 5, sha256: 'c'.repeat(64) },
  ] as const;

  it('writes SHA256SUMS in the sha256sum format', () => {
    expect(sha256sums([...files])).toBe(
      `${'a'.repeat(64)}  openlive-helper-0.2.0-linux-amd64.tar.gz\n` +
        `${'b'.repeat(64)}  openlive-helper-0.2.0.flatpak\n` +
        `${'c'.repeat(64)}  openlive-helper-0.2.0-macos.dmg\n`,
    );
  });

  it("writes a latest.json the Worker accepts, at the Worker's keys", () => {
    const manifest = buildManifest({
      version: '0.2.0',
      publishedAt: new Date('2026-10-28T12:00:00Z'),
      protocol: { major: 1, minor: 12 },
      releaseNotesUrl: null,
      files: [...files],
    });
    expect(manifest.signature).toBeNull();
    const parsed = parseHelperManifest(JSON.stringify(manifest));
    expect(parsed?.files.map((f) => f.size)).toEqual([9, 7, 5]);
    expect(parsed?.files.map((f) => `${f.os}/${f.arch}`)).toEqual([
      'linux/amd64',
      'linux/amd64',
      'macos/universal',
    ]);
    expect(LATEST_KEY).toBe(WORKER_LATEST_KEY);
    for (const f of [...files, { name: 'SHA256SUMS' }]) {
      expect(objectKey('0.2.0', f.name)).toBe(helperFileKey('0.2.0', f.name));
      expect(helperFileOf('0.2.0', f.name)).not.toBeNull();
    }
  });
});
