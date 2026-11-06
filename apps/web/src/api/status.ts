// SPDX-License-Identifier: AGPL-3.0-only
import {
  getSpaceStatus,
  type SpaceStatus,
  STATUS_RANGES,
  type StatusRange,
  type StatusSummary,
  type StatusUnavailable,
  type TtffStats,
} from '@openlive/client';
import { queryOptions } from '@tanstack/react-query';
import { apiGet, apiSend, webApi } from './client.ts';
import { queryClient } from './query-client.ts';

export { STATUS_RANGES };
export type { SpaceStatus, StatusRange, StatusSummary, StatusUnavailable, TtffStats };

// The space status page and the admin's view of every space: the last 24 hours or 7
// days of playback and helper metrics, read by the Worker from Analytics Engine
// (apps/api/src/metrics/status.ts).

export interface SpaceStatusRow {
  spaceId: string;
  /** Null for a deleted space (its metrics stay three months). */
  name: string | null;
  slug: string | null;
  summary?: StatusSummary;
}

export type AdminStatus = { range: StatusRange } & (
  { available: true; summary: StatusSummary; spaces: SpaceStatusRow[] } | StatusUnavailable
);

export const spaceStatusQuery = (spaceId: string, range: StatusRange) =>
  queryOptions({
    queryKey: ['space', spaceId, 'status', range],
    queryFn: () => getSpaceStatus(webApi, spaceId, range),
    refetchInterval: 60_000,
  });

export const adminStatusQuery = (range: StatusRange) =>
  queryOptions({
    queryKey: ['admin', 'status', range],
    queryFn: () => apiGet<AdminStatus>(`/api/admin/status?range=${range}`),
    refetchInterval: 60_000,
  });

// The Cloudflare limits panel (apps/api/src/usage/cloudflare-limits.ts).

export const LIMIT_METRICS = [
  'doRowsWritten',
  'doRowsRead',
  'doRequests',
  'doDuration',
  'd1RowsWritten',
  'd1RowsRead',
  'workerRequests',
] as const;
export type LimitMetric = (typeof LIMIT_METRICS)[number];
/** Warning and critical shares of a limit (same as the API). */
export const LIMIT_WARN_RATIO = 0.7;
export const LIMIT_CRITICAL_RATIO = 0.9;

export const WORKERS_PLANS = ['detect', 'free', 'paid'] as const;
export type WorkersPlanSetting = (typeof WORKERS_PLANS)[number];

/** Why a figure is not known; `detail` is what Cloudflare said (an error message, a status). */
export type LimitUnavailable = (
  | { reason: 'not_configured'; missing: string[] }
  | { reason: 'permission'; permission: string }
  | { reason: 'not_exposed' }
  | { reason: 'failed' }
) & { detail?: string };

/**
 * Null when Cloudflare does not give the figure, with the reason. `empty`: Cloudflare reported no
 * rows for the window (nothing yet, or its analytics lagging), so the 0 says so.
 */
export type LimitFigure = { used: number; empty?: true } | ({ used: null } & LimitUnavailable);

/** One GraphQL query of the panel and Cloudflare's raw answer (the "raw responses" disclosure). */
export interface LimitQueryTrace {
  metric: LimitMetric;
  window: 'today' | 'last24h' | 'month';
  query: string;
  variables: { since: string; until?: string };
  status: number | null;
  response: string;
}

export interface LimitsReport {
  plan: {
    setting: WorkersPlanSetting;
    detected: 'free' | 'paid' | null;
    detection: LimitUnavailable | null;
    effective: 'free' | 'paid' | null;
  };
  fetchedAt: number;
  resetsAt: number;
  today: Record<LimitMetric, LimitFigure>;
  /** The 24 hours before `fetchedAt` (D1 by whole hours). */
  last24h: Record<LimitMetric, LimitFigure>;
  month: { start: string; figures: Record<LimitMetric, LimitFigure>; overageUsd: number } | null;
  limits: {
    freeDaily: Record<LimitMetric, number>;
    paidMonthly: Record<LimitMetric, number>;
    paidUsdPerMillion: Record<LimitMetric, number>;
  };
  /** Workers Logs events, estimated from the invocations and the sampling. */
  logs: {
    sampling: number;
    today: LimitFigure;
    last24h: LimitFigure;
    month: LimitFigure | null;
    freeDaily: number;
    paidMonthly: number;
    paidUsdPerMillion: number;
  };
  debug: LimitQueryTrace[];
}

export const limitsQuery = queryOptions({
  queryKey: ['admin', 'limits'],
  queryFn: () => apiGet<LimitsReport>('/api/admin/limits'),
  refetchInterval: 5 * 60_000,
});

export async function setWorkersPlan(plan: WorkersPlanSetting): Promise<void> {
  await apiSend('PUT', '/api/admin/workers-plan', { plan });
  await queryClient.invalidateQueries({ queryKey: limitsQuery.queryKey });
}
