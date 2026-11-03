// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';
import { ApiError, apiGet } from './client.ts';

// The helper release this instance offers: GET /api/helper/latest, the
// helper/latest.json that `pnpm run helper:publish` uploads (apps/api/src/helper/release.ts), and
// the Android APK in GET /api/helper/android (helper/android.json).

export interface HelperFile {
  name: string;
  /** tarball and flatpak are linux/amd64, dmg is macos/universal. */
  kind: 'tarball' | 'flatpak' | 'dmg';
  os: 'linux' | 'macos';
  arch: 'amd64' | 'universal';
  size: number;
  sha256: string;
  /**
   * Where to download it: the public GitHub release asset when the manifest names one, otherwise a
   * same-origin path that the session cookie authorizes (a build the instance serves from R2).
   */
  url: string;
}

export interface HelperRelease {
  schema: 1;
  version: string;
  publishedAt: string;
  protocol: { major: number; minor: number };
  releaseNotesUrl: string | null;
  files: HelperFile[];
  signature: null;
}

/**
 * What the Download page can offer: the release, nothing published yet (404), or not for this
 * caller (401 signed out, 403 in no space).
 */
export type HelperReleaseState =
  | { kind: 'release'; release: HelperRelease }
  | { kind: 'unpublished' }
  | { kind: 'signedOut' }
  | { kind: 'noSpace' };

export const helperReleaseQuery = queryOptions({
  queryKey: ['helper', 'latest'],
  queryFn: async (): Promise<HelperReleaseState> => {
    try {
      return { kind: 'release', release: await apiGet<HelperRelease>('/api/helper/latest') };
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 404) return { kind: 'unpublished' };
        if (error.status === 401) return { kind: 'signedOut' };
        if (error.status === 403) return { kind: 'noSpace' };
      }
      throw error;
    }
  },
  retry: false,
});

/** The APK of an Android release on GitHub (helper/android.json). */
export interface AndroidRelease {
  schema: 1;
  version: string;
  publishedAt: string;
  name: string;
  /** The public GitHub release asset. */
  url: string;
  size: number;
  sha256: string;
}

/**
 * The APK this instance links to, or null when none was published or the caller may not see it;
 * the Android card then only links to the releases page.
 */
export const androidReleaseQuery = queryOptions({
  queryKey: ['helper', 'android'],
  queryFn: async (): Promise<AndroidRelease | null> => {
    try {
      return await apiGet<AndroidRelease>('/api/helper/android');
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return null;
      throw error;
    }
  },
  retry: false,
});
