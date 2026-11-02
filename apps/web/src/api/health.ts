// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';
import { apiGet } from './client.ts';

export interface Health {
  ok: boolean;
  version: string;
  /** Short git commit of the deployed build, "-dirty" with local changes, "dev" locally. */
  commit: string;
  builtAt: string | null;
}

export const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: () => apiGet<Health>('/api/health'),
  retry: false,
});
