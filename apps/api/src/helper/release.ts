// SPDX-License-Identifier: AGPL-3.0-only
// The helper's release files in the instance's private R2 bucket, written by
// `pnpm run helper:publish` (scripts/setup/src/helper-publish.ts) and served only by the Worker to
// signed-in people (GET /api/helper/latest, GET /api/helper/download/:version/:file).
//
// They share the THUMBNAILS bucket under their own prefix: the setup creates and owns one private
// bucket per instance, and a second binding would mean a second bucket for every self-hoster. The
// thumbnail sweep lists only `thumbnails/`, so it never sees these.
//
//   helper/<version>/openlive-helper-<version>-linux-amd64.tar.gz
//   helper/<version>/openlive-helper-<version>.flatpak
//   helper/<version>/openlive-helper-<version>-macos.dmg   (universal, notarized)
//   helper/<version>/SHA256SUMS
//   helper/latest.json   (written last, so it never names a file that is not there yet)
//   helper/android.json  (the Android app's APK; optional, published on its own)
//
// A manifest file may instead point at an absolute https URL: the asset of a public GitHub release
// (`pnpm run helper:publish -- --from-release X.Y.Z`). Then nothing of that version sits in R2 and
// the browser downloads it from GitHub; the manifest keeps the per-server version pin. The URL is
// checked against the release repository (HELPER_RELEASE_REPO, default the official public one).

import { z } from 'zod';

export const HELPER_PREFIX = 'helper/';
export const LATEST_KEY = `${HELPER_PREFIX}latest.json`;
export const ANDROID_KEY = `${HELPER_PREFIX}android.json`;
/** The public repository whose releases an instance links to unless HELPER_RELEASE_REPO says otherwise. */
export const DEFAULT_RELEASE_REPO = 'henriquefps/openlive';
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** The configured release repository (owner/name), or the default when unset or malformed. */
export function releaseRepoOf(configured: string | undefined): string {
  const repo = configured?.trim();
  return repo && REPO_PATTERN.test(repo) ? repo : DEFAULT_RELEASE_REPO;
}

/**
 * True for `https://github.com/<repo>/releases/download/<tag>/<name>` and nothing else: no
 * credentials, port, query or fragment, and the tag and name must be the exact ones given.
 */
export function isReleaseAssetUrl(url: string, repo: string, tag: string, name: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    u.host === 'github.com' &&
    u.username === '' &&
    u.password === '' &&
    u.search === '' &&
    u.hash === '' &&
    u.pathname ===
      `/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
  );
}
/** The format of latest.json; the publish script writes the same number. */
export const MANIFEST_SCHEMA = 1;

/** Same pattern as the protocol's HelperVersion (packages/protocol/schema/rest.json). */
export const HELPER_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;

export type HelperFileKind = 'tarball' | 'flatpak' | 'dmg' | 'checksums';

/** The file names a release may hold, by kind. Anything else under helper/ is never served. */
export function helperFileName(version: string, kind: HelperFileKind): string {
  switch (kind) {
    case 'tarball':
      return `openlive-helper-${version}-linux-amd64.tar.gz`;
    case 'flatpak':
      return `openlive-helper-${version}.flatpak`;
    case 'dmg':
      return `openlive-helper-${version}-macos.dmg`;
    case 'checksums':
      return 'SHA256SUMS';
  }
}

export const helperFileKey = (version: string, name: string): string =>
  `${HELPER_PREFIX}${version}/${name}`;

const CONTENT_TYPES: Record<HelperFileKind, string> = {
  tarball: 'application/gzip',
  flatpak: 'application/vnd.flatpak',
  dmg: 'application/x-apple-diskimage',
  checksums: 'text/plain; charset=utf-8',
};

/** The kind and content type of a requested file, or null when the name is not one of ours. */
export function helperFileOf(
  version: string,
  name: string,
): { kind: HelperFileKind; contentType: string } | null {
  if (!HELPER_VERSION.test(version) || version.length > 64) return null;
  for (const kind of ['tarball', 'flatpak', 'dmg', 'checksums'] as const) {
    if (helperFileName(version, kind) === name) return { kind, contentType: CONTENT_TYPES[kind] };
  }
  return null;
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const protocolVersion = z.object({
  major: z.number().int().min(0),
  minor: z.number().int().min(0),
});

/** The platform each kind is built for: Linux x86-64, or one universal macOS image. */
const PLATFORM = {
  tarball: { os: 'linux', arch: 'amd64' },
  flatpak: { os: 'linux', arch: 'amd64' },
  dmg: { os: 'macos', arch: 'universal' },
} as const;

const manifestFile = z
  .object({
    name: z.string().min(1).max(128),
    /** Absolute URL of a GitHub release asset; absent for a file in R2 (checked by parseHelperManifest). */
    url: z.url().max(512).optional(),
    kind: z.enum(['tarball', 'flatpak', 'dmg']),
    os: z.enum(['linux', 'macos']),
    arch: z.enum(['amd64', 'universal']),
    size: z.number().int().min(0),
    sha256,
  })
  .refine((f) => f.os === PLATFORM[f.kind].os && f.arch === PLATFORM[f.kind].arch, {
    message: 'a file names another platform than its kind',
  });

/** helper/latest.json. Unknown fields are dropped, so later publishers may add some. */
export const helperManifest = z
  .object({
    schema: z.literal(MANIFEST_SCHEMA),
    version: z.string().regex(HELPER_VERSION).max(64),
    publishedAt: z.iso.datetime(),
    /** The protocol version this build speaks (docs/PROTOCOL.md 1). */
    protocol: protocolVersion,
    releaseNotesUrl: z.url().nullable(),
    files: z.array(manifestFile).min(1).max(8),
    /**
     * Reserved for the signed auto-update (a signature over this file, checked
     * against a public key built into the helper). Always null until that ships.
     */
    signature: z.null(),
  })
  .refine((m) => m.files.every((f) => f.name === helperFileName(m.version, f.kind)), {
    message: 'a file name does not match its kind and version',
  });

export type HelperManifest = z.output<typeof helperManifest>;

/**
 * The parsed manifest, or null when the text is not one (logged by the caller). A file with a
 * `url` must point at that version's helper-v<version> release asset in `repo`.
 */
export function parseHelperManifest(
  text: string,
  repo: string = DEFAULT_RELEASE_REPO,
): HelperManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = helperManifest.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  const tag = `helper-v${m.version}`;
  return m.files.every((f) => f.url === undefined || isReleaseAssetUrl(f.url, repo, tag, f.name))
    ? m
    : null;
}

/** The version of the Android app (SemVer without a suffix, as scripts/release/android-release.sh tags it). */
export const ANDROID_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
export const androidApkName = (version: string): string => `openlive-${version}-android.apk`;

/** helper/android.json: the APK of an `android-v<version>` release, linked from the Download page. */
export const androidManifest = z.object({
  schema: z.literal(MANIFEST_SCHEMA),
  version: z.string().regex(ANDROID_VERSION).max(64),
  publishedAt: z.iso.datetime(),
  name: z.string().min(1).max(128),
  url: z.url().max(512),
  size: z.number().int().min(0),
  sha256,
});

export type AndroidManifest = z.output<typeof androidManifest>;

/** The parsed Android entry, or null when the text is not one or its URL is not the release's APK. */
export function parseAndroidManifest(
  text: string,
  repo: string = DEFAULT_RELEASE_REPO,
): AndroidManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = androidManifest.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  return a.name === androidApkName(a.version) &&
    isReleaseAssetUrl(a.url, repo, `android-v${a.version}`, a.name)
    ? a
    : null;
}
