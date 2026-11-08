// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiClient } from './client.ts';

// The space status page: the last 24 hours or 7 days of playback and helper metrics,
// read by the Worker from Analytics Engine (apps/api/src/metrics/status.ts). The admin's view of
// every space stays in the web.

export const STATUS_RANGES = ['24h', '7d'] as const;
export type StatusRange = (typeof STATUS_RANGES)[number];

export interface TtffStats {
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
}

export interface StatusSummary {
  streamsEnded: number;
  streamsDropped: number;
  dropRate: number | null;
  viewerMinutes: number;
  freezesPerHour: number | null;
  reconnects: number;
  decodeErrors: number;
  ttff: TtffStats & { click: TtffStats; prepull: TtffStats };
  helper: {
    minutes: number;
    sentFps: number | null;
    capturedFps: number | null;
    sentKbps: number | null;
    cpuPct: number | null;
    keyframeRequestsPerHour: number | null;
    idrMaxBytes: number | null;
  };
  topErrors: { code: string; count: number }[];
  /**
   * Durable Object circuit breaker trips, by object class (RoomDO, SpaceDO, UserHubDO) and cause
   * (alarm, request, message, total, socket). Absent from an older Worker.
   */
  breakerTrips?: { object: string; cause: string; count: number }[];
}

/** Why there is nothing to show: no token, a token without the permission, or the API failed. */
export type StatusUnavailable =
  | { available: false; reason: 'not_configured'; missing: string[] }
  | { available: false; reason: 'permission'; permission: string }
  | { available: false; reason: 'unavailable' };

export type SpaceStatus = { range: StatusRange } & (
  { available: true; summary: StatusSummary } | StatusUnavailable
);

export const getSpaceStatus = (api: ApiClient, spaceId: string, range: StatusRange) =>
  api.get<SpaceStatus>(`/api/spaces/${encodeURIComponent(spaceId)}/status?range=${range}`);
