// SPDX-License-Identifier: AGPL-3.0-only

// The "update available" banner's rules, without React or React Native so Vitest tests them. Each
// instance may serve the Android app's release manifest (GET /api/helper/android); the app is
// compared with the highest version any signed-in instance offers.

export const DISMISSED_KEY = 'openlive.updateDismissed';

/** The manifest of GET /api/helper/android, as far as the banner needs it. */
export interface AndroidManifest {
  version: string;
  url: string;
  size: number;
}

export interface AvailableUpdate extends AndroidManifest {
  /** The instance whose manifest this is. */
  origin: string;
}

/** The official public repository: fixed in the app, a self-hosted release repo shows no banner. */
export const RELEASE_REPO = 'henriquefps/openlive';

/** The only link the banner opens: the APK of the `android-v<version>` release of RELEASE_REPO. */
export function androidApkUrl(version: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/android-v${version}/openlive-${version}-android.apk`;
}

const SEMVER = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;

/** `X.Y.Z` as numbers; null for anything else (pre-releases and build metadata included). */
export function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const m = SEMVER.exec(value);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** Negative, zero or positive like a sort comparator; null when either is not `X.Y.Z`. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

/**
 * A manifest the banner can use: a valid version and exactly the official APK link of that
 * version (so no other host, repo, tag, name, port, credentials, query or fragment). The manifest
 * comes from any server the user added; the server validates it, the app must not rely on that.
 */
export function parseManifest(value: unknown): AndroidManifest | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, url, size } = value as Record<string, unknown>;
  if (parseVersion(version) === null || typeof url !== 'string') return null;
  if (url !== androidApkUrl(version as string)) return null;
  return {
    version: version as string,
    url,
    size: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0,
  };
}

/** The newest version newer than `installed` among the servers' manifests (null: none). */
export function pickUpdate(
  installed: string,
  offers: ReadonlyArray<{ origin: string; manifest: unknown }>,
): AvailableUpdate | null {
  let best: AvailableUpdate | null = null;
  for (const { origin, manifest } of offers) {
    const m = parseManifest(manifest);
    if (!m) continue;
    const newer = compareVersions(m.version, installed);
    if (newer === null || newer <= 0) continue;
    if (best === null || (compareVersions(m.version, best.version) ?? 0) > 0)
      best = { ...m, origin };
  }
  return best;
}

/** Whether to show the banner: an update exists and that exact version was not dismissed. */
export function shouldShowUpdate(
  update: AvailableUpdate | null,
  dismissed: string | null,
): update is AvailableUpdate {
  return update !== null && update.version !== dismissed;
}

/** The saved dismissed version; anything that is not `X.Y.Z` counts as none. */
export function readDismissed(raw: string | null | undefined): string | null {
  return parseVersion(raw) ? (raw as string) : null;
}

/** The size in decimal megabytes (1 MB = 1,000,000 bytes, as GitHub shows) with one decimal ("12.3"), or null when unknown. */
export function sizeInMb(bytes: number): string | null {
  return bytes > 0 ? (bytes / 1_000_000).toFixed(1) : null;
}
