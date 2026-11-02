// SPDX-License-Identifier: AGPL-3.0-only

// Cloudflare's limits that this app can reach, checked against the docs on
// 2026-10-28:
// - developers.cloudflare.com/durable-objects/platform/pricing/ (SQLite-backed objects).
//   Workers Free: requests 100,000/day ("HTTP requests, RPC sessions, WebSocket messages, and
//   alarm invocations"; a 20:1 ratio applies to incoming WebSocket messages for billing), duration
//   13,000 GB-s/day, rows read 5 million/day, rows written 100,000/day ("Each setAlarm() is billed
//   as a single row written"). Workers Paid: requests 1 million/month + $0.15/million, duration
//   400,000 GB-s/month + $12.50/million GB-s, rows read 25 billion/month + $0.001/million, rows
//   written 50 million/month + $1.00/million.
// - developers.cloudflare.com/d1/platform/pricing/: Free rows read 5 million/day, rows written
//   100,000/day; Paid 25 billion/month + $0.001/million read, 50 million/month + $1.00/million
//   written.
// - developers.cloudflare.com/workers/platform/limits/ and /pricing/: Free 100,000 requests/day;
//   Paid 10 million/month + $0.30/million (and a $5 monthly minimum).
// Free limits are hard caps that Cloudflare documents as resetting at 00:00 UTC: past one, every
// further operation of that kind fails until then. A block has been seen to outlast 00:00 UTC
//. Paid amounts are included each month and billed beyond.

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

/** Workers Free: per day, hard caps. doDuration in GB-s. */
export const FREE_TIER_DAILY = {
  doRowsWritten: 100_000,
  doRowsRead: 5_000_000,
  doRequests: 100_000,
  doDuration: 13_000,
  d1RowsWritten: 100_000,
  d1RowsRead: 5_000_000,
  workerRequests: 100_000,
} as const satisfies Record<LimitMetric, number>;

/** Workers Paid: included per month. */
export const PAID_MONTHLY_INCLUDED = {
  doRowsWritten: 50_000_000,
  doRowsRead: 25_000_000_000,
  doRequests: 1_000_000,
  doDuration: 400_000,
  d1RowsWritten: 50_000_000,
  d1RowsRead: 25_000_000_000,
  workerRequests: 10_000_000,
} as const satisfies Record<LimitMetric, number>;

/** Workers Paid: USD per million beyond the included amount (list prices). */
export const PAID_USD_PER_MILLION = {
  doRowsWritten: 1,
  doRowsRead: 0.001,
  doRequests: 0.15,
  doDuration: 12.5,
  d1RowsWritten: 1,
  d1RowsRead: 0.001,
  workerRequests: 0.3,
} as const satisfies Record<LimitMetric, number>;

/** The admin panel warns from this share of a limit, and shows it as critical from the next. */
export const LIMIT_WARN_RATIO = 0.7;
export const LIMIT_CRITICAL_RATIO = 0.9;

// Workers Logs, checked on 2026-10-28:
// - developers.cloudflare.com/workers/platform/pricing/ ("Log Events Written"): Workers Free
//   200,000 a day (3 days kept); Workers Paid 20 million a month, then $0.60 per million.
// - developers.cloudflare.com/workers/observability/logs/workers-logs/: one invocation log per
//   invocation plus each console line; head_sampling_rate keeps that share of invocations with
//   all their logs. Past the limit "a 1% head-based sample will be applied for the remainder of
//   the day": logs are thinned, requests are not refused.
// - developers.cloudflare.com/observability/pricing/: from 2026-12-01 Workers Logs move to
//   Observability pricing, Free 0.5 GB ingested a day (ingestion stops at the limit until
//   00:00 UTC), Paid 50 GB a month then $0.25 per GB. Measured in bytes, not events.

/** Workers Free: log events written a day. */
export const LOGS_FREE_DAILY = 200_000;
/** Workers Paid: log events included a month, and USD per million beyond. */
export const LOGS_PAID_MONTHLY_INCLUDED = 20_000_000;
export const LOGS_PAID_USD_PER_MILLION = 0.6;
/** The template's head_sampling_rate (wrangler.jsonc env.production). */
export const DEFAULT_LOG_SAMPLING = 0.1;

/** The sampling rate from LOG_SAMPLING_RATE; missing or invalid means everything is logged. */
export function logSamplingOf(value: string | undefined): number {
  const rate = value === undefined || value.trim() === '' ? NaN : Number(value);
  return rate >= 0 && rate <= 1 ? rate : 1;
}

/**
 * Log events an amount of work writes: an invocation log per invocation (a Worker request, a
 * cron run, a Durable Object request, WebSocket message or alarm) plus a line per console call,
 * of the sampled share.
 */
export function logEvents(invocations: number, consoleLines: number, sampling: number): number {
  return (invocations + consoleLines) * sampling;
}
