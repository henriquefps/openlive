// SPDX-License-Identifier: AGPL-3.0-only
// The space status page and the admin's view of it: the metrics of the last 24 hours
// or 7 days, read back from Analytics Engine through its SQL API. The Worker has no binding to
// read a dataset, so it calls the API with the instance's CLOUDFLARE_API_TOKEN (the usage cron's
// token: Account > Account Analytics > Read covers the SQL API too). Without the token, or with a
// token that lacks the permission, the page says so instead of failing. The token is a
// parameter here: nothing in this file reads secrets.

import { HELPER_DOUBLES, STREAM_DOUBLES, VIEWER_DOUBLES } from './points';

export const DATASET = 'openlive_metrics';
export const SQL_ENDPOINT = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`;
/** The permission the SQL API needs, as the Cloudflare dashboard names it. */
export const REQUIRED_PERMISSION = 'Account Analytics: Read';

export const STATUS_RANGES = { '24h': "INTERVAL '1' DAY", '7d': "INTERVAL '7' DAY" } as const;
export type StatusRange = keyof typeof STATUS_RANGES;

export interface TtffStats {
  /** Watches that reported a first frame. */
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
}

export interface StatusSummary {
  /** Streams that ended in the range, and those whose helper vanished (a drop). */
  streamsEnded: number;
  streamsDropped: number;
  /** streamsDropped / streamsEnded, null without ended streams. */
  dropRate: number | null;
  viewerMinutes: number;
  freezesPerHour: number | null;
  reconnects: number;
  decodeErrors: number;
  ttff: TtffStats & { click: TtffStats; prepull: TtffStats };
  helper: {
    /** Stream minutes the helper reported for. */
    minutes: number;
    sentFps: number | null;
    capturedFps: number | null;
    sentKbps: number | null;
    cpuPct: number | null;
    keyframeRequestsPerHour: number | null;
    idrMaxBytes: number | null;
  };
  topErrors: { code: string; count: number }[];
  /** Durable Object circuit breaker trips, by object class and cause. */
  breakerTrips: { object: string; cause: string; count: number }[];
}

export type StatusResult =
  | { available: true; summaries: Map<string, StatusSummary> }
  | { available: false; reason: 'not_configured'; missing: string[] }
  | { available: false; reason: 'permission'; permission: string }
  | { available: false; reason: 'unavailable' };

export interface StatusConfig {
  token: string | undefined;
  accountId: string | undefined;
}

type Row = Record<string, unknown>;

/** The SQL API refused the token (401/403). */
export class PermissionError extends Error {}

/** Runs one query and returns its rows. */
export async function runSql(
  config: { token: string; accountId: string },
  sql: string,
  fetchFn: typeof fetch = fetch,
): Promise<Row[]> {
  const res = await fetchFn(SQL_ENDPOINT(config.accountId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}` },
    body: `${sql} FORMAT JSON`,
  });
  if (res.status === 401 || res.status === 403) throw new PermissionError(String(res.status));
  const text = await res.text();
  if (!res.ok) {
    // Before the first write the dataset does not exist yet: that is "no data", not an error.
    if (/unknown (table|dataset)|does not exist|not found/i.test(text)) return [];
    // The API answers an authentication problem in the body as well.
    if (/authenticat|permission|not authorized/i.test(text)) throw new PermissionError(text);
    throw new Error(`analytics engine sql: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as { data?: Row[] };
  return json.data ?? [];
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Column positions by name, so the queries read like the layouts in points.ts. */
const col = (layout: readonly string[], name: string) => `double${layout.indexOf(name) + 1}`;
const v = (name: (typeof VIEWER_DOUBLES)[number]) => col(VIEWER_DOUBLES, name);
const h = (name: (typeof HELPER_DOUBLES)[number]) => col(HELPER_DOUBLES, name);
const st = (name: (typeof STREAM_DOUBLES)[number]) => col(STREAM_DOUBLES, name);

/**
 * The queries of one status view. `spaceId` limits them to one space; `bySpace` groups the rows
 * by space (the admin's table) instead of one row for everything in scope.
 */
export function statusQueries(range: StatusRange, spaceId: string | null, bySpace: boolean) {
  if (spaceId !== null && !SAFE_ID.test(spaceId)) throw new RangeError('bad space id');
  const where = (kind: string, extra = '') =>
    `WHERE blob1 = '${kind}' AND timestamp > NOW() - ${STATUS_RANGES[range]}` +
    (spaceId !== null ? ` AND index1 = '${spaceId}'` : '') +
    extra;
  const key = bySpace ? 'index1' : "'all'";
  const group = (more = '') => `GROUP BY space${more}`;
  const w = '_sample_interval';
  const quantiles = `quantileExactWeighted(0.5)(${v('ttffMs')}, ${w}) AS p50,
    quantileExactWeighted(0.9)(${v('ttffMs')}, ${w}) AS p90`;
  return {
    viewer: `SELECT ${key} AS space, sum(${w} * ${v('watchS')}) AS watch_s,
      sum(${w} * ${v('freezes')}) AS freezes, sum(${w} * ${v('reconnects')}) AS reconnects,
      sum(${w} * ${v('decodeErrors')}) AS decode_errors
      FROM ${DATASET} ${where('viewer')} ${group()}`,
    ttff: `SELECT ${key} AS space, sum(${w}) AS n, ${quantiles}
      FROM ${DATASET} ${where('viewer', ` AND ${v('hasTtff')} = 1`)} ${group()}`,
    ttffByStart: `SELECT ${key} AS space, blob6 AS start, sum(${w}) AS n, ${quantiles}
      FROM ${DATASET} ${where('viewer', ` AND ${v('hasTtff')} = 1`)} ${group(', start')}`,
    helper: `SELECT ${key} AS space, sum(${w}) AS n, sum(${w} * ${h('windowS')}) AS window_s,
      sum(${w} * ${h('sentFps')}) AS sent_fps, sum(${w} * ${h('capturedFps')}) AS captured_fps,
      sumIf(${w}, ${h('capturedFps')} > 0) AS captured_n,
      sum(${w} * ${h('sentKbps')}) AS sent_kbps, sum(${w} * ${h('cpuPct')}) AS cpu,
      sum(${w} * ${h('keyframeRequests')}) AS kfr, max(${h('idrMaxBytes')}) AS idr_max
      FROM ${DATASET} ${where('helper')} ${group()}`,
    stream: `SELECT ${key} AS space, sum(${w}) AS ended, sum(${w} * ${st('dropped')}) AS dropped
      FROM ${DATASET} ${where('stream')} ${group()}`,
    errors: `SELECT ${key} AS space, blob6 AS code, sum(${w}) AS n
      FROM ${DATASET} ${where('error')} ${group(', code')} ORDER BY n DESC LIMIT 200`,
    breaker: `SELECT ${key} AS space, blob5 AS object, blob7 AS cause, sum(${w}) AS n
      FROM ${DATASET} ${where('breaker')} ${group(', object, cause')} ORDER BY n DESC LIMIT 200`,
  };
}

const num = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};
const ratio = (a: number, b: number, digits = 1): number | null =>
  b > 0 ? Math.round((a / b) * 10 ** digits) / 10 ** digits : null;

function emptyTtff(): TtffStats {
  return { count: 0, medianMs: null, p90Ms: null };
}

export function emptySummary(): StatusSummary {
  return {
    streamsEnded: 0,
    streamsDropped: 0,
    dropRate: null,
    viewerMinutes: 0,
    freezesPerHour: null,
    reconnects: 0,
    decodeErrors: 0,
    ttff: { ...emptyTtff(), click: emptyTtff(), prepull: emptyTtff() },
    helper: {
      minutes: 0,
      sentFps: null,
      capturedFps: null,
      sentKbps: null,
      cpuPct: null,
      keyframeRequestsPerHour: null,
      idrMaxBytes: null,
    },
    topErrors: [],
    breakerTrips: [],
  };
}

const ttffOf = (row: Row): TtffStats => {
  const count = Math.round(num(row['n']));
  return count > 0
    ? { count, medianMs: Math.round(num(row['p50'])), p90Ms: Math.round(num(row['p90'])) }
    : emptyTtff();
};

/** Turns the rows of statusQueries() into one summary per space (or one under 'all'). */
export function summarize(rows: Record<keyof ReturnType<typeof statusQueries>, Row[]>) {
  const out = new Map<string, StatusSummary>();
  const of = (row: Row) => {
    const key = String(row['space'] ?? 'all');
    let s = out.get(key);
    if (!s) out.set(key, (s = emptySummary()));
    return s;
  };
  for (const row of rows.viewer) {
    const s = of(row);
    const watchS = num(row['watch_s']);
    s.viewerMinutes = Math.round(watchS / 60);
    s.freezesPerHour = ratio(num(row['freezes']), watchS / 3600);
    s.reconnects = Math.round(num(row['reconnects']));
    s.decodeErrors = Math.round(num(row['decode_errors']));
  }
  for (const row of rows.ttff) Object.assign(of(row).ttff, ttffOf(row));
  for (const row of rows.ttffByStart) {
    const start = row['start'];
    if (start === 'click' || start === 'prepull') of(row).ttff[start] = ttffOf(row);
  }
  for (const row of rows.helper) {
    const s = of(row);
    const n = num(row['n']);
    const windowS = num(row['window_s']);
    s.helper = {
      minutes: Math.round(windowS / 60),
      sentFps: ratio(num(row['sent_fps']), n),
      capturedFps: ratio(num(row['captured_fps']), num(row['captured_n'])),
      sentKbps: ratio(num(row['sent_kbps']), n, 0),
      cpuPct: ratio(num(row['cpu']), n),
      keyframeRequestsPerHour: ratio(num(row['kfr']), windowS / 3600),
      idrMaxBytes: n > 0 ? Math.round(num(row['idr_max'])) : null,
    };
  }
  for (const row of rows.stream) {
    const s = of(row);
    s.streamsEnded = Math.round(num(row['ended']));
    s.streamsDropped = Math.round(num(row['dropped']));
    s.dropRate = ratio(s.streamsDropped, s.streamsEnded, 3);
  }
  for (const row of rows.errors) {
    const s = of(row);
    if (s.topErrors.length < 5) {
      s.topErrors.push({ code: String(row['code'] ?? ''), count: Math.round(num(row['n'])) });
    }
  }
  for (const row of rows.breaker) {
    of(row).breakerTrips.push({
      object: String(row['object'] ?? ''),
      cause: String(row['cause'] ?? ''),
      count: Math.round(num(row['n'])),
    });
  }
  return out;
}

/** A finished answer per query set, for a minute: page loads must not spend the query budget. */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: StatusResult }>();

export function clearStatusCache(): void {
  cache.clear();
}

export async function loadStatus(
  config: StatusConfig,
  range: StatusRange,
  spaceId: string | null,
  bySpace: boolean,
  now: number = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<StatusResult> {
  const { token, accountId } = config;
  if (!token || !accountId) {
    const missing = Object.entries({
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    })
      .filter(([, value]) => !value)
      .map(([name]) => name);
    return { available: false, reason: 'not_configured', missing };
  }
  const cacheKey = `${range}|${spaceId ?? '*'}|${bySpace}`;
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < CACHE_MS) return hit.value;

  const queries = statusQueries(range, spaceId, bySpace);
  let value: StatusResult;
  try {
    const names = Object.keys(queries) as (keyof typeof queries)[];
    const results = await Promise.all(
      names.map((name) => runSql({ token, accountId }, queries[name], fetchFn)),
    );
    const rows = Object.fromEntries(names.map((name, i) => [name, results[i] ?? []])) as Record<
      keyof typeof queries,
      Row[]
    >;
    value = { available: true, summaries: summarize(rows) };
  } catch (error) {
    if (error instanceof PermissionError) {
      value = { available: false, reason: 'permission', permission: REQUIRED_PERMISSION };
    } else {
      console.warn('status: analytics engine query failed', error);
      // Not cached: the next load tries again.
      return { available: false, reason: 'unavailable' };
    }
  }
  cache.set(cacheKey, { at: now, value });
  return value;
}
