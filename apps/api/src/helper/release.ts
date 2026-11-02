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

import { z } from 'zod';

export const HELPER_PREFIX = 'helper/';
export const LATEST_KEY = `${HELPER_PREFIX}latest.json`;
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

/** The parsed manifest, or null when the text is not one (logged by the caller). */
export function parseHelperManifest(text: string): HelperManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = helperManifest.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
