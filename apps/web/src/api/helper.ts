// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';
import { ApiError, apiGet } from './client.ts';

// The helper release this instance serves: GET /api/helper/latest, the
// helper/latest.json that `pnpm run helper:publish` uploads (apps/api/src/helper/release.ts).

export interface HelperFile {
  name: string;
  /** tarball and flatpak are linux/amd64, dmg is macos/universal. */
  kind: 'tarball' | 'flatpak' | 'dmg';
  os: 'linux' | 'macos';
  arch: 'amd64' | 'universal';
  size: number;
  sha256: string;
  /** Same-origin download path; the session cookie authorizes it. */
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
