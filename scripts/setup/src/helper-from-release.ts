// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm run helper:publish -- --from-release <x.y.z|latest> [--android-from-release <x.y.z>]`:
// point the instance at the official builds of GitHub releases (helper-v<x.y.z>, drafted by
// .github/workflows/release-helper.yml with the macOS disk image added by the maintainer:
// packaging/RELEASING.md; android-v<x.y.z> by scripts/release/android-release.sh). Nothing is
// copied: the release is only read (public REST API with fetch, no gh, no token), every wanted
// asset must exist and be listed in the release's SHA256SUMS, and what goes to the instance's R2
// bucket is the manifest alone (helper/latest.json, helper/android.json) with the GitHub asset
// URLs and hashes. The Download page links the browser straight to GitHub; the instance keeps
// serving exactly the version it was pinned to. The network and wrangler come in as functions, so
// the tests mock both.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ANDROID_KEY,
  androidApkName,
  buildAndroidManifest,
  buildManifest,
  CHECKSUMS_NAME,
  CONTENT_TYPES,
  dmgName,
  type FileKind,
  flatpakName,
  type HashedFile,
  helperProtocol,
  LATEST_KEY,
  type PublishArgs,
  shellLine,
  stagingPath,
  tarballName,
  type Upload,
  uploadCommand,
  validAndroidVersion,
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
const ANDROID_TAG_PREFIX = 'android-v';

export const releaseTag = (version: string, prefix = TAG_PREFIX) => `${prefix}${version}`;

/** The public download URL of a release asset; the Worker accepts exactly this shape. */
export const assetUrl = (repo: string, tag: string, name: string) =>
  `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;

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
  prefix = TAG_PREFIX,
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
      .filter((r) => r.tag_name.startsWith(prefix))
      .filter((r) => validVersion(r.tag_name.slice(prefix.length)))
      .filter((r) => !r.draft && (allowPrerelease || !r.prerelease))
      .sort((a, b) =>
        compareVersions(b.tag_name.slice(prefix.length), a.tag_name.slice(prefix.length)),
      );
    const newest = candidates[0];
    if (!newest) {
      throw new ReleaseError(
        `${where} has no published ${prefix}* release yet` +
          (allowPrerelease ? '' : ' (prereleases are skipped without --allow-prerelease)') +
          ': build from source instead (leave out --from-release)',
      );
    }
    release = newest;
  } else {
    const tag = releaseTag(which, prefix);
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

export interface ReleaseFile {
  name: string;
  kind: FileKind;
  url: string;
  /** Bytes, as GitHub reports them. */
  size: number;
}

/** The helper files of the release, in the order the page lists them, and its SHA256SUMS. */
export function releaseFiles(
  release: GitHubRelease,
  repo: string,
): {
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
    files.push({ name, kind, url: assetUrl(repo, release.tag_name, name), size: a.size });
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

/** The APK of an android-v<version> release, with its size and the SHA256SUMS to read its hash from. */
export function androidAsset(
  release: GitHubRelease,
  repo: string,
): { version: string; name: string; url: string; size: number; checksumsUrl: string } {
  const version = release.tag_name.slice(ANDROID_TAG_PREFIX.length);
  if (!release.tag_name.startsWith(ANDROID_TAG_PREFIX) || !validAndroidVersion(version)) {
    throw new ReleaseError(`${release.tag_name} is not an ${ANDROID_TAG_PREFIX}<version> release`);
  }
  const name = androidApkName(version);
  const apk = release.assets.find((a) => a.name === name);
  if (!apk) throw new ReleaseError(`${release.tag_name} has no ${name}`);
  const sums = release.assets.find((a) => a.name === CHECKSUMS_NAME);
  if (!sums) {
    throw new ReleaseError(
      `${release.tag_name} has no ${CHECKSUMS_NAME}, so ${name} cannot be checked; not publishing it`,
    );
  }
  return {
    version,
    name,
    url: assetUrl(repo, release.tag_name, name),
    size: apk.size,
    checksumsUrl: sums.browser_download_url,
  };
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

/** The hash SHA256SUMS lists for `name`; the release must list it. */
export function hashOf(sums: Map<string, string>, name: string): string {
  const h = sums.get(name);
  if (!h) throw new ReleaseError(`${CHECKSUMS_NAME} of the release does not list ${name}`);
  return h;
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
  /** The repository root: the staged manifests go under its build/. */
  root: string;
  now?: () => Date;
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

interface HelperPlan {
  release: GitHubRelease;
  version: string;
  files: (ReleaseFile & { sha256: string })[];
  protocol: { major: number; minor: number };
}
interface AndroidPlan {
  release: GitHubRelease;
  version: string;
  name: string;
  url: string;
  size: number;
  sha256: string;
}

const stagedLatest = (version: string) => stagingPath(version, 'latest.json');
const stagedAndroid = (version: string) => stagingPath(`android-${version}`, 'android.json');

export function formatFromReleasePlan(input: {
  args: PublishArgs;
  facts: InstanceFacts;
  helper: HelperPlan | null;
  android: AndroidPlan | null;
  uploads: Upload[];
}): string {
  const { args, facts, helper, android, uploads } = input;
  const lines = [
    `Point ${facts.instanceUrl} at the public releases of github.com/${args.releaseRepo}`,
    `Bucket ${facts.bucketName} (private), config ${facts.generatedConfig}, env ${args.env}`,
    'Only the manifests are written to R2; the files stay on GitHub and the browser downloads them from there.',
  ];
  if (helper) {
    const dmg = helper.files.some((f) => f.kind === 'dmg');
    lines.push(
      '',
      `Helper ${helper.version}: release ${helper.release.tag_name}, ${helper.release.html_url}` +
        (helper.release.published_at ? ` (published ${helper.release.published_at})` : ''),
      `Each asset exists and is listed in the release's ${CHECKSUMS_NAME}:`,
      ...helper.files.map(
        (f, i) =>
          `  ${i + 1}. ${f.name} (${f.kind}, ${mb(f.size)})\n     ${f.url}\n     sha256 ${f.sha256}`,
      ),
      dmg
        ? 'macOS: the disk image above, as the maintainer built, notarized and attached it'
        : 'macOS: none (the release has no disk image; the Download page says macOS is not available)',
      `Protocol ${helper.protocol.major}.${helper.protocol.minor}, from helper/internal/api/room.go at ${helper.release.tag_name}`,
    );
  }
  if (android) {
    lines.push(
      '',
      `Android ${android.version}: release ${android.release.tag_name}, ${android.release.html_url}`,
      `  ${android.name} (${mb(android.size)})\n     ${android.url}\n     sha256 ${android.sha256}`,
    );
  }
  lines.push(
    '',
    `Manifests are staged in ${stagingPath('<version>', '')} and uploaded from apps/api (the pinned wrangler, the account in the generated config):`,
    ...uploads.map(
      (u, i) =>
        `  ${i + 1}. ${u.key}\n     ${shellLine({ command: uploadCommand(facts.bucketName, args.env, u) })}`,
    ),
  );
  return lines.join('\n');
}

/**
 * The whole --from-release / --android-from-release run. It only reads the releases (a few
 * kilobytes: the release metadata, SHA256SUMS and room.go) and uploads at most two small manifests.
 */
export async function publishFromRelease(
  args: PublishArgs,
  facts: InstanceFacts,
  deps: FromReleaseDeps,
): Promise<void> {
  if (args.fromRelease === undefined && args.androidFromRelease === undefined) {
    throw new ReleaseError('--from-release or --android-from-release is missing');
  }
  let helper: HelperPlan | null = null;
  if (args.fromRelease !== undefined) {
    const release = await findRelease(
      deps.fetch,
      args.releaseRepo,
      args.fromRelease,
      args.allowPrerelease,
    );
    const { version, files, checksumsUrl } = releaseFiles(release, args.releaseRepo);
    const sums = parseSha256sums(
      await getText(deps.fetch, checksumsUrl, `${CHECKSUMS_NAME} of ${release.tag_name}`),
    );
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
    helper = {
      release,
      version,
      files: files.map((f) => ({ ...f, sha256: hashOf(sums, f.name) })),
      protocol,
    };
  }
  let android: AndroidPlan | null = null;
  if (args.androidFromRelease !== undefined) {
    // The Android app is a beta and its releases are prereleases (scripts/release/android-release.sh).
    const release = await findRelease(
      deps.fetch,
      args.releaseRepo,
      args.androidFromRelease,
      true,
      ANDROID_TAG_PREFIX,
    );
    const apk = androidAsset(release, args.releaseRepo);
    const sums = parseSha256sums(
      await getText(deps.fetch, apk.checksumsUrl, `${CHECKSUMS_NAME} of ${release.tag_name}`),
    );
    android = { release, ...apk, sha256: hashOf(sums, apk.name) };
  }

  const uploads: Upload[] = [];
  if (helper) {
    uploads.push({
      key: LATEST_KEY,
      path: stagedLatest(helper.version),
      contentType: CONTENT_TYPES.manifest,
    });
  }
  if (android) {
    uploads.push({
      key: ANDROID_KEY,
      path: stagedAndroid(android.version),
      contentType: CONTENT_TYPES.manifest,
    });
  }
  deps.log(formatFromReleasePlan({ args, facts, helper, android, uploads }));
  if (args.dryRun) {
    deps.log('\nDry run: nothing was staged or uploaded.');
    return;
  }

  const now = (deps.now ?? (() => new Date()))();
  const write = (path: string, value: unknown) => {
    const abs = join(deps.root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`);
  };
  if (helper) {
    const hashed: (HashedFile & { url: string })[] = helper.files.map((f) => ({
      name: f.name,
      kind: f.kind,
      size: f.size,
      sha256: f.sha256,
      url: f.url,
    }));
    write(
      stagedLatest(helper.version),
      buildManifest({
        version: helper.version,
        publishedAt: now,
        protocol: helper.protocol,
        releaseNotesUrl: args.releaseNotesUrl ?? helper.release.html_url,
        files: hashed,
      }),
    );
  }
  if (android) {
    write(
      stagedAndroid(android.version),
      buildAndroidManifest({
        version: android.version,
        publishedAt: now,
        name: android.name,
        url: android.url,
        size: android.size,
        sha256: android.sha256,
      }),
    );
  }
  for (const u of uploads) {
    deps.log(`→ ${u.key}`);
    deps.upload(uploadCommand(facts.bucketName, args.env, u));
  }
  const done = [
    helper && `openlive-helper ${helper.version} (${helper.release.tag_name})`,
    android && `the Android app ${android.version} (${android.release.tag_name})`,
  ].filter(Boolean);
  deps.log(`\nPublished ${done.join(' and ')}: ${facts.instanceUrl}/download shows it to members.`);
}
