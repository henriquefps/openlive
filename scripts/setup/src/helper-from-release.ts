// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm run helper:publish -- --from-release <x.y.z|latest>`: publish the official build of a
// GitHub release (drafted by .github/workflows/release-helper.yml, the macOS disk image added by
// the maintainer: packaging/RELEASING.md) instead of building it. Reads the public REST API with
// fetch (no gh, no token), downloads each asset over HTTPS, checks its size and SHA-256 against
// the release's SHA256SUMS, and only then uploads, in the same order and layout as a local build
// (helper-release.ts). The network and wrangler come in as functions, so the tests mock both.

import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  buildManifest,
  CHECKSUMS_NAME,
  dmgName,
  type FileKind,
  flatpakName,
  type HashedFile,
  helperProtocol,
  type PublishArgs,
  type PublishFile,
  sha256sums,
  shellLine,
  stagingPath,
  tarballName,
  type Upload,
  uploadCommand,
  uploadsFor,
  validVersion,
} from './helper-release.ts';

export class ReleaseError extends Error {}

/** The fields of GitHub's release object this uses (GET /repos/{owner}/{repo}/releases/...). */
export interface GitHubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: { name: string; size: number; browser_download_url: string }[];
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'openlive-helper-publish',
  'x-github-api-version': '2022-11-28',
};
const TAG_PREFIX = 'helper-v';

export const releaseTag = (version: string) => `${TAG_PREFIX}${version}`;

async function getJson(fetch: Fetch, url: string, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: HEADERS });
  } catch (err) {
    throw new ReleaseError(`could not reach GitHub for ${what}: ${(err as Error).message}`);
  }
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) {
    throw new ReleaseError(
      `GitHub refused ${what} (HTTP ${res.status}, likely the unauthenticated rate limit of 60 ` +
        'requests an hour): try again later',
    );
  }
  if (!res.ok) throw new ReleaseError(`GitHub answered HTTP ${res.status} for ${what}`);
  return res.json();
}

/** 0.2.10 > 0.2.9; a version without a suffix after the same one with a suffix. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => {
    const [core = '', suffix] = v.split(/(?=[-+])/, 2);
    return { nums: core.split('.').map(Number), suffix };
  };
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.suffix === pb.suffix) return 0;
  if (pa.suffix === undefined) return 1;
  if (pb.suffix === undefined) return -1;
  return pa.suffix < pb.suffix ? -1 : 1;
}

/**
 * The release to publish: helper-v<version>, or with `latest` the highest helper-v* version
 * among the published ones (the repository may have other releases). Drafts are not visible
 * without a token, but a draft or a prerelease is refused here too.
 */
export async function findRelease(
  fetch: Fetch,
  repo: string,
  which: string,
  allowPrerelease: boolean,
): Promise<GitHubRelease> {
  const where = `github.com/${repo}`;
  let release: GitHubRelease;
  if (which === 'latest') {
    const list = (await getJson(
      fetch,
      `${API}/repos/${repo}/releases?per_page=100`,
      `the releases of ${where}`,
    )) as GitHubRelease[] | null;
    if (list === null) throw new ReleaseError(`${where} does not exist or is not public`);
    const candidates = list
      .filter((r) => r.tag_name.startsWith(TAG_PREFIX))
      .filter((r) => validVersion(r.tag_name.slice(TAG_PREFIX.length)))
      .filter((r) => !r.draft && (allowPrerelease || !r.prerelease))
      .sort((a, b) =>
        compareVersions(b.tag_name.slice(TAG_PREFIX.length), a.tag_name.slice(TAG_PREFIX.length)),
      );
    const newest = candidates[0];
    if (!newest) {
      throw new ReleaseError(
        `${where} has no published ${TAG_PREFIX}* release yet` +
          (allowPrerelease ? '' : ' (prereleases are skipped without --allow-prerelease)') +
          ': build from source instead (leave out --from-release)',
      );
    }
    release = newest;
  } else {
    const tag = releaseTag(which);
    const found = (await getJson(
      fetch,
      `${API}/repos/${repo}/releases/tags/${tag}`,
      `the release ${tag} of ${where}`,
    )) as GitHubRelease | null;
    if (found === null) {
      throw new ReleaseError(
        `${where} has no published release ${tag} (a draft is not visible until it is ` +
          'published): pick another version, `latest`, or build from source instead (leave out ' +
          '--from-release)',
      );
    }
    release = found;
  }
  if (release.draft) throw new ReleaseError(`${release.tag_name} is a draft: publish it first`);
  if (release.prerelease && !allowPrerelease) {
    throw new ReleaseError(
      `${release.tag_name} is a prerelease: pass --allow-prerelease to publish it anyway`,
    );
  }
  return release;
}

export interface ReleaseFile extends PublishFile {
  url: string;
  /** Bytes, as GitHub reports them. */
  size: number;
}

/** The helper files of the release, in the order they are uploaded, and its SHA256SUMS. */
export function releaseFiles(release: GitHubRelease): {
  version: string;
  files: ReleaseFile[];
  checksumsUrl: string;
} {
  const version = release.tag_name.slice(TAG_PREFIX.length);
  if (!release.tag_name.startsWith(TAG_PREFIX) || !validVersion(version)) {
    throw new ReleaseError(`${release.tag_name} is not a ${TAG_PREFIX}<version> release`);
  }
  const asset = (name: string) => release.assets.find((a) => a.name === name);
  const wanted: [FileKind, string][] = [
    ['tarball', tarballName(version)],
    ['flatpak', flatpakName(version)],
    ['dmg', dmgName(version)],
  ];
  const files: ReleaseFile[] = [];
  for (const [kind, name] of wanted) {
    const a = asset(name);
    if (!a) continue;
    files.push({
      name,
      kind,
      path: stagingPath(version, `release/${name}`),
      url: a.browser_download_url,
      size: a.size,
    });
  }
  if (!files.some((f) => f.kind === 'tarball')) {
    throw new ReleaseError(`${release.tag_name} has no ${tarballName(version)}`);
  }
  const sums = asset(CHECKSUMS_NAME);
  if (!sums) {
    throw new ReleaseError(
      `${release.tag_name} has no ${CHECKSUMS_NAME}, so its files cannot be checked; not publishing it`,
    );
  }
  return { version, files, checksumsUrl: sums.browser_download_url };
}

/** `sha256sum` output (also the `*name` binary form) → name → lowercase hex. */
export function parseSha256sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m?.[1] && m[2]) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

async function getText(fetch: Fetch, url: string, what: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': HEADERS['user-agent'] } });
  } catch (err) {
    throw new ReleaseError(`could not download ${what}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new ReleaseError(`downloading ${what} failed: HTTP ${res.status}`);
  return res.text();
}

/** Each file must be listed; returns the expected hash per file. */
export function expectedHashes(files: ReleaseFile[], sums: Map<string, string>): string[] {
  return files.map((f) => {
    const h = sums.get(f.name);
    if (!h) throw new ReleaseError(`${CHECKSUMS_NAME} of the release does not list ${f.name}`);
    return h;
  });
}

/**
 * Streams one asset to `dest`, hashing it on the way; throws (and removes the partial file) when
 * the size or the SHA-256 is not the expected one.
 */
export async function downloadVerified(
  fetch: Fetch,
  file: ReleaseFile,
  sha256: string,
  dest: string,
): Promise<HashedFile> {
  let res: Response;
  try {
    res = await fetch(file.url, { headers: { 'user-agent': HEADERS['user-agent'] } });
  } catch (err) {
    throw new ReleaseError(`could not download ${file.name}: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) {
    throw new ReleaseError(`downloading ${file.name} failed: HTTP ${res.status}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  const hash = createHash('sha256');
  let size = 0;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    size += chunk.length;
  });
  await pipeline(body, createWriteStream(dest));
  const got = hash.digest('hex');
  if (size !== file.size || got !== sha256) {
    rmSync(dest, { force: true });
    throw new ReleaseError(
      `${file.name} does not match the release: ` +
        (size !== file.size
          ? `${size} bytes, GitHub lists ${file.size}`
          : `SHA-256 ${got}, ${CHECKSUMS_NAME} says ${sha256}`) +
        '. Nothing was uploaded.',
    );
  }
  return { name: file.name, kind: file.kind, size, sha256: got };
}

export interface InstanceFacts {
  bucketName: string;
  /** Repository-relative, for the plan. */
  generatedConfig: string;
  instanceUrl: string;
}

export interface FromReleaseDeps {
  fetch: Fetch;
  /** Runs one wrangler upload (the argv of uploadCommand); throws on failure. */
  upload: (command: string[]) => void;
  log: (line: string) => void;
  /** The repository root: downloads and the staged files go under its build/. */
  root: string;
  now?: () => Date;
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

export function formatFromReleasePlan(input: {
  args: PublishArgs;
  facts: InstanceFacts;
  release: GitHubRelease;
  version: string;
  files: ReleaseFile[];
  protocol: { major: number; minor: number };
  uploads: Upload[];
}): string {
  const { args, facts, release, version, files, protocol, uploads } = input;
  const dmg = files.find((f) => f.kind === 'dmg');
  return [
    `Publish openlive-helper ${version} from the release ${release.tag_name} of ` +
      `github.com/${args.releaseRepo} to ${facts.instanceUrl}`,
    `Release ${release.html_url}` +
      (release.published_at ? ` (published ${release.published_at})` : ''),
    `Bucket ${facts.bucketName} (private), config ${facts.generatedConfig}, env ${args.env}`,
    '',
    `Download over HTTPS into ${stagingPath(version, 'release/')}, each checked against the`,
    `release's ${CHECKSUMS_NAME} (all listed) and its size, before anything is uploaded:`,
    ...files.map((f, i) => `  ${i + 1}. ${f.name} (${f.kind}, ${mb(f.size)})`),
    dmg
      ? 'macOS: the disk image above, as the maintainer built, notarized and attached it'
      : 'macOS: none (the release has no disk image; the Download page says macOS is not available)',
    '',
    `Then: SHA256SUMS and latest.json (protocol ${protocol.major}.${protocol.minor}, from ` +
      `helper/internal/api/room.go at ${release.tag_name})`,
    `  (${stagingPath(version, '')})`,
    '',
    'Upload, from apps/api (the pinned wrangler, the account in the generated config):',
    ...uploads.map(
      (u, i) =>
        `  ${i + 1}. ${u.key}\n     ${shellLine({ command: uploadCommand(facts.bucketName, args.env, u) })}`,
    ),
  ].join('\n');
}

/**
 * The whole --from-release run. The dry run reads only the release, its SHA256SUMS and room.go
 * (a few kilobytes), then prints the plan.
 */
export async function publishFromRelease(
  args: PublishArgs,
  facts: InstanceFacts,
  deps: FromReleaseDeps,
): Promise<void> {
  if (args.fromRelease === undefined) throw new ReleaseError('--from-release is missing');
  const release = await findRelease(
    deps.fetch,
    args.releaseRepo,
    args.fromRelease,
    args.allowPrerelease,
  );
  const { version, files, checksumsUrl } = releaseFiles(release);
  const sums = parseSha256sums(
    await getText(deps.fetch, checksumsUrl, `${CHECKSUMS_NAME} of ${release.tag_name}`),
  );
  const expected = expectedHashes(files, sums);
  const protocol = helperProtocol(
    await getText(
      deps.fetch,
      `${RAW}/${args.releaseRepo}/${release.tag_name}/helper/internal/api/room.go`,
      `helper/internal/api/room.go at ${release.tag_name}`,
    ),
  );
  if (!protocol) {
    throw new ReleaseError(
      `could not read the protocol version from room.go at ${release.tag_name}`,
    );
  }
  const uploads = uploadsFor(version, files);
  deps.log(formatFromReleasePlan({ args, facts, release, version, files, protocol, uploads }));
  if (args.dryRun) {
    deps.log('\nDry run: nothing was downloaded or uploaded.');
    return;
  }

  // Everything is downloaded and checked first: a bad file stops the run before any upload.
  const hashed: HashedFile[] = [];
  for (const [i, f] of files.entries()) {
    deps.log(`\n↓ ${f.name}`);
    hashed.push(await downloadVerified(deps.fetch, f, expected[i] ?? '', join(deps.root, f.path)));
  }
  const write = (name: string, text: string) => {
    const path = join(deps.root, stagingPath(version, name));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  write(CHECKSUMS_NAME, sha256sums(hashed));
  const manifest = buildManifest({
    version,
    publishedAt: (deps.now ?? (() => new Date()))(),
    protocol,
    releaseNotesUrl: args.releaseNotesUrl ?? release.html_url,
    files: hashed,
  });
  write('latest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  deps.log(`\n${sha256sums(hashed)}`);

  for (const u of uploads) {
    deps.log(`→ ${u.key}`);
    deps.upload(uploadCommand(facts.bucketName, args.env, u));
  }
  deps.log(
    `\nPublished openlive-helper ${version} from ${release.tag_name}: ${facts.instanceUrl}/download shows it to members.`,
  );
}
