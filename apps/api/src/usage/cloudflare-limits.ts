// SPDX-License-Identifier: AGPL-3.0-only
import {
  FREE_TIER_DAILY,
  LIMIT_METRICS,
  type LimitMetric,
  logEvents,
  LOGS_FREE_DAILY,
  LOGS_PAID_MONTHLY_INCLUDED,
  LOGS_PAID_USD_PER_MILLION,
  PAID_MONTHLY_INCLUDED,
  PAID_USD_PER_MILLION,
} from './free-tier';
import { GRAPHQL_ENDPOINT } from './realtime-usage';

// The admin's "Cloudflare limits" panel: the use of each Workers Free daily limit
// today (UTC) and over the last 24 hours, and, on Workers Paid, the month's use against the
// included amounts with the overage at list prices. Figures come from Cloudflare's GraphQL Analytics
// API with the instance's CLOUDFLARE_API_TOKEN (Account Analytics: Read, the usage cron's token);
// the plan from the account's subscriptions (Billing Read) or the admin's choice. Every figure is
// its own query, so a dataset or field the API does not expose for the account leaves only that
// row "not available" with Cloudflare's own message, never a made-up zero. The token is a
// parameter: nothing here reads secrets.
//
// Cloudflare documents that "Daily free limits reset at 00:00 UTC"
// (developers.cloudflare.com/durable-objects/platform/pricing/), but on 2026-10-29 production
// was still refused rows written well after 00:00 UTC, as others report on the Cloudflare
// Community. So the panel shows both windows and the copy says the limit frees up within 24 hours
// rather than promising midnight.

export const ANALYTICS_PERMISSION = 'Account Analytics: Read';
export const BILLING_PERMISSION = 'Billing Read';
export const SUBSCRIPTIONS_ENDPOINT = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/subscriptions`;

/**
 * Where each figure comes from: dataset, sum field and the time dimension that filters a window
 * shorter than a day. Datasets from developers.cloudflare.com/durable-objects/observability/
 * metrics-and-analytics/, /d1/observability/metrics-analytics/ and /analytics/graphql-api/
 * tutorials/querying-workers-metrics/ (which filters workersInvocationsAdaptive on `datetime`).
 * The DO docs name no rows or duration fields; `rowsRead`, `rowsWritten` and `duration` (GB-s) on
 * durableObjectsPeriodicGroups are what public Cloudflare usage scripts query. The D1 docs filter
 * on `date` only, so the last 24 hours of D1 go by `datetimeHour` (whole hours: up to 25 h).
 */
export const METRIC_SOURCES = {
  doRowsWritten: {
    dataset: 'durableObjectsPeriodicGroups',
    field: 'rowsWritten',
    time: 'datetime',
  },
  doRowsRead: { dataset: 'durableObjectsPeriodicGroups', field: 'rowsRead', time: 'datetime' },
  doRequests: {
    dataset: 'durableObjectsInvocationsAdaptiveGroups',
    field: 'requests',
    time: 'datetime',
  },
  doDuration: { dataset: 'durableObjectsPeriodicGroups', field: 'duration', time: 'datetime' },
  d1RowsWritten: {
    dataset: 'd1AnalyticsAdaptiveGroups',
    field: 'rowsWritten',
    time: 'datetimeHour',
  },
  d1RowsRead: { dataset: 'd1AnalyticsAdaptiveGroups', field: 'rowsRead', time: 'datetimeHour' },
  workerRequests: { dataset: 'workersInvocationsAdaptive', field: 'requests', time: 'datetime' },
} as const satisfies Record<
  LimitMetric,
  { dataset: string; field: string; time: 'datetime' | 'datetimeHour' }
>;

export const WORKERS_PLANS = ['detect', 'free', 'paid'] as const;
export type WorkersPlanSetting = (typeof WORKERS_PLANS)[number];
export type WorkersPlan = 'free' | 'paid';

/**
 * Why a figure or the plan is not known. `detail` is what Cloudflare said (a GraphQL error
 * message, an HTTP status), shown to the platform admin as is.
 */
export type Unavailable = (
  | { reason: 'not_configured'; missing: string[] }
  | { reason: 'permission'; permission: string }
  | { reason: 'not_exposed' }
  | { reason: 'failed' }
) & { detail?: string };

/**
 * A figure. `empty`: Cloudflare answered with no rows for the window, which it does when nothing
 * happened yet (or its analytics lag behind, a few minutes), so the panel says so next to the 0.
 */
export type Figure = { used: number; empty?: true } | ({ used: null } & Unavailable);

export type LimitWindow = 'today' | 'last24h' | 'month';

/** One GraphQL query and what came back, for the panel's "raw response" disclosure. */
export interface QueryTrace {
  metric: LimitMetric;
  window: LimitWindow;
  query: string;
  variables: { since: string; until?: string };
  /** HTTP status; null when the request itself failed. */
  status: number | null;
  /** The response body, cut at RAW_RESPONSE_MAX characters. */
  response: string;
}

export const RAW_RESPONSE_MAX = 2_000;

export interface PlanInfo {
  /** The admin's choice (platform_settings `workers_plan`), detect by default. */
  setting: WorkersPlanSetting;
  /** What the account's subscriptions say; null when they could not be read. */
  detected: WorkersPlan | null;
  /** Why detection did not answer (with `detect` and no answer, the panel asks the admin). */
  detection: Unavailable | null;
  /** The plan the panel uses: the setting, or the detected one; null when unknown. */
  effective: WorkersPlan | null;
}

/**
 * Workers Logs events. The GraphQL API documents no dataset for them, so they are
 * estimated: the Worker's and the Durable Objects' invocations (requests, cron runs, WebSocket
 * messages and alarms) times the head sampling rate. Console lines add to it; the app keeps those
 * to warnings and errors, so they are left out. Past the free limit Cloudflare keeps 1 % of the
 * logs for the rest of the day; nothing else is refused.
 */
export interface LogsEstimate {
  /** head_sampling_rate as the setup deployed it (LOG_SAMPLING_RATE). */
  sampling: number;
  today: Figure;
  last24h: Figure;
  month: Figure | null;
  freeDaily: number;
  paidMonthly: number;
  paidUsdPerMillion: number;
}

/** Estimated log events from the invocation figures; unknown when either figure is. */
export function logsFigure(figures: Record<LimitMetric, Figure>, sampling: number): Figure {
  const { workerRequests: worker, doRequests: objects } = figures;
  if (worker.used === null) return worker;
  if (objects.used === null) return objects;
  return { used: Math.round(logEvents(worker.used + objects.used, 0, sampling)) };
}

export interface LimitsReport {
  plan: PlanInfo;
  /** When the figures were read (they lag Cloudflare by a few minutes). */
  fetchedAt: number;
  /** The next 00:00 UTC, when Cloudflare documents that the free limits reset. */
  resetsAt: number;
  /** Today (UTC) for every metric, against FREE_TIER_DAILY. */
  today: Record<LimitMetric, Figure>;
  /** The 24 hours before `fetchedAt` (D1: from the start of that hour), against FREE_TIER_DAILY. */
  last24h: Record<LimitMetric, Figure>;
  /** On Workers Paid: the calendar month so far (UTC), against PAID_MONTHLY_INCLUDED. */
  month: { start: string; figures: Record<LimitMetric, Figure>; overageUsd: number } | null;
  limits: {
    freeDaily: typeof FREE_TIER_DAILY;
    paidMonthly: typeof PAID_MONTHLY_INCLUDED;
    paidUsdPerMillion: typeof PAID_USD_PER_MILLION;
  };
  logs: LogsEstimate;
  /** Every query and its raw answer (the endpoint is the platform admin's only). */
  debug: QueryTrace[];
}

/**
 * The query of one figure. `date` filters whole UTC days from `$since` (a Date); `datetime` and
 * `datetimeHour` filter `$since`..`$until` (Times).
 */
export function limitQuery(
  dataset: string,
  field: string,
  by: 'date' | 'datetime' | 'datetimeHour' = 'date',
): string {
  const vars = by === 'date' ? '$since: Date!' : '$since: Time!, $until: Time!';
  const filter = by === 'date' ? 'date_geq: $since' : `${by}_geq: $since, ${by}_leq: $until`;
  return `query Limits($account: string!, ${vars}) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      groups: ${dataset}(limit: 10000, filter: { ${filter} }) {
        sum { ${field} }
      }
    }
  }
}`;
}

/** A window of one query: `date` from a UTC day, or a time range. */
type Range = { window: LimitWindow; since: string; until?: string };

type GraphQLAnswer = {
  data?: {
    viewer?: {
      accounts?: { groups?: { sum?: Record<string, unknown> | null }[] | null }[] | null;
    } | null;
  } | null;
  errors?: { message?: string; path?: unknown; extensions?: unknown }[] | null;
};

// Error messages from developers.cloudflare.com/analytics/graphql-api/errors/: authorization
// ("Unauthorized", "not authorized for that account", "does not have access to the path") and
// parsing ("unknown field", "error parsing args", "query contains error", selections).
const PERMISSION_TEXT = /unauthori[sz]ed|not authori[sz]ed|does not have access|permission/i;
const NOT_EXPOSED_TEXT = /unknown (field|arg)|error parsing|query contains error|selections/i;

/**
 * What a GraphQL answer says about one figure. Cloudflare answers a refused query with an
 * `errors` list, on a 200 or on a 4xx status (400 for an unknown field or a time range the
 * dataset does not allow, 403 for a missing permission, 429 for its rate limit), and a window
 * without data with an empty group list.
 */
export function figureFromAnswer(json: GraphQLAnswer, field: string, status = 200): Figure {
  if (json.errors?.length) {
    const detail = json.errors.map((e) => e.message ?? JSON.stringify(e)).join('; ');
    if (status === 401 || status === 403 || PERMISSION_TEXT.test(detail)) {
      return { used: null, reason: 'permission', permission: ANALYTICS_PERMISSION, detail };
    }
    if (NOT_EXPOSED_TEXT.test(detail)) return { used: null, reason: 'not_exposed', detail };
    return { used: null, reason: 'failed', detail };
  }
  if (status === 401 || status === 403) {
    return {
      used: null,
      reason: 'permission',
      permission: ANALYTICS_PERMISSION,
      detail: `HTTP ${status}`,
    };
  }
  if (status < 200 || status > 299) {
    return { used: null, reason: 'failed', detail: `HTTP ${status}` };
  }
  const accounts = json.data?.viewer?.accounts;
  if (!accounts?.length) {
    return {
      used: null,
      reason: 'failed',
      detail: 'no account in the answer: check CLOUDFLARE_ACCOUNT_ID and the token’s account',
    };
  }
  const groups = accounts[0]?.groups;
  if (!Array.isArray(groups)) {
    return { used: null, reason: 'failed', detail: 'the dataset is missing from the answer' };
  }
  if (groups.length === 0) return { used: 0, empty: true };
  let used = 0;
  for (const group of groups) {
    const value = group.sum?.[field];
    if (value === undefined || value === null) {
      return {
        used: null,
        reason: 'not_exposed',
        detail: `sum.${field} is missing from the answer`,
      };
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return {
        used: null,
        reason: 'failed',
        detail: `sum.${field} is not a number: ${String(value)}`,
      };
    }
    used += n;
  }
  return { used };
}

/** One figure over one window, and the trace of its query. */
async function readFigure(
  token: string,
  accountId: string,
  range: Range,
  metric: LimitMetric,
  fetchFn: typeof fetch,
): Promise<{ figure: Figure; trace: QueryTrace }> {
  const { dataset, field, time } = METRIC_SOURCES[metric];
  const query = limitQuery(dataset, field, range.until === undefined ? 'date' : time);
  const variables =
    range.until === undefined
      ? { since: range.since }
      : {
          since: time === 'datetimeHour' ? floorToHour(range.since) : range.since,
          until: range.until,
        };
  const trace: QueryTrace = {
    metric,
    window: range.window,
    query,
    variables,
    status: null,
    response: '',
  };
  try {
    const res = await fetchFn(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { account: accountId, ...variables } }),
    });
    trace.status = res.status;
    const text = await res.text();
    trace.response = text.slice(0, RAW_RESPONSE_MAX);
    let json: GraphQLAnswer;
    try {
      json = JSON.parse(text) as GraphQLAnswer;
    } catch {
      // A proxy or an outage page: the status and the start of the body.
      json = { errors: [{ message: `HTTP ${res.status}: ${text.slice(0, 200)}` }] };
    }
    return { figure: figureFromAnswer(json, field, res.status), trace };
  } catch (error) {
    console.warn('limits: graphql query failed', error);
    const detail = error instanceof Error ? error.message : String(error);
    trace.response = detail;
    return { figure: { used: null, reason: 'failed', detail }, trace };
  }
}

/** The start of the hour of an ISO time, for `datetimeHour` filters. */
function floorToHour(iso: string): string {
  const hour = 3_600_000;
  return new Date(Math.floor(Date.parse(iso) / hour) * hour).toISOString();
}

async function readFigures(
  config: { token: string; accountId: string },
  range: Range,
  fetchFn: typeof fetch,
): Promise<{ figures: Record<LimitMetric, Figure>; traces: QueryTrace[] }> {
  const read = await Promise.all(
    LIMIT_METRICS.map((m) => readFigure(config.token, config.accountId, range, m, fetchFn)),
  );
  return {
    figures: Object.fromEntries(LIMIT_METRICS.map((m, i) => [m, read[i]?.figure])) as Record<
      LimitMetric,
      Figure
    >,
    traces: read.map((r) => r.trace),
  };
}

/**
 * The account's Workers plan from GET /accounts/:id/subscriptions (Billing Read). The docs list
 * no rate plan id for Workers Paid, so a live subscription whose plan id or public name mentions
 * Workers and paid (or bundled, standard, unbound: the usage models it had) counts as Paid; a
 * readable list without one means Free.
 */
export async function detectWorkersPlan(
  token: string,
  accountId: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ plan: WorkersPlan } | Unavailable> {
  try {
    const res = await fetchFn(SUBSCRIPTIONS_ENDPOINT(accountId), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { reason: 'permission', permission: BILLING_PERMISSION };
    }
    if (!res.ok) return { reason: 'failed', detail: `HTTP ${res.status}` };
    const json = (await res.json()) as {
      success?: boolean;
      result?: { state?: string; rate_plan?: { id?: string; public_name?: string } }[] | null;
    };
    if (!Array.isArray(json.result)) {
      return { reason: 'failed', detail: 'no result list in the subscriptions answer' };
    }
    return { plan: json.result.some(isWorkersPaid) ? 'paid' : 'free' };
  } catch (error) {
    console.warn('limits: subscriptions request failed', error);
    return { reason: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

const ENDED_STATES = new Set(['cancelled', 'expired', 'failed']);

function isWorkersPaid(s: {
  state?: string;
  rate_plan?: { id?: string; public_name?: string };
}): boolean {
  if (ENDED_STATES.has((s.state ?? '').toLowerCase())) return false;
  const name = `${s.rate_plan?.id ?? ''} ${s.rate_plan?.public_name ?? ''}`.toLowerCase();
  return /workers/.test(name) && /paid|bundled|standard|unbound/.test(name);
}

/**
 * USD beyond the included amounts, at list prices; unknown figures count as nothing. With
 * `logs`, the month's estimated log events too.
 */
export function overageUsd(figures: Record<LimitMetric, Figure>, logs?: Figure): number {
  let usd = 0;
  for (const m of LIMIT_METRICS) {
    const used = figures[m].used;
    if (used === null) continue;
    usd += (Math.max(0, used - PAID_MONTHLY_INCLUDED[m]) / 1_000_000) * PAID_USD_PER_MILLION[m];
  }
  if (logs?.used != null) {
    const over = Math.max(0, logs.used - LOGS_PAID_MONTHLY_INCLUDED);
    usd += (over / 1_000_000) * LOGS_PAID_USD_PER_MILLION;
  }
  return usd;
}

const DAY_MS = 86_400_000;

/** The next 00:00 UTC after `now`. */
export function nextUtcMidnight(now: number): number {
  return (Math.floor(now / DAY_MS) + 1) * DAY_MS;
}

/** Figures are cached this long per isolate, so the panel does not spend requests itself. */
export const LIMITS_CACHE_MS = 5 * 60_000;
/** The plan detection is cached longer: it changes when the admin changes plans. */
const PLAN_CACHE_MS = 60 * 60_000;
let figuresCache: {
  at: number;
  key: string;
  value: Omit<LimitsReport, 'plan' | 'logs'>;
} | null = null;
let planCache: { at: number; value: { plan: WorkersPlan } | Unavailable } | null = null;

/** For tests: forget the cached figures and plan. */
export function resetLimitsCache(): void {
  figuresCache = null;
  planCache = null;
}

export async function loadLimits(
  config: { token: string | undefined; accountId: string | undefined; logSampling?: number },
  setting: WorkersPlanSetting,
  now: number = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<LimitsReport> {
  const { token, accountId } = config;
  const sampling = config.logSampling ?? 1;
  const resetsAt = nextUtcMidnight(now);
  const limits = {
    freeDaily: FREE_TIER_DAILY,
    paidMonthly: PAID_MONTHLY_INCLUDED,
    paidUsdPerMillion: PAID_USD_PER_MILLION,
  };
  if (!token || !accountId) {
    const missing = Object.entries({
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    })
      .filter(([, value]) => !value)
      .map(([name]) => name);
    const unknown: Figure = { used: null, reason: 'not_configured', missing };
    const detection: Unavailable = { reason: 'not_configured', missing };
    const effective = setting === 'detect' ? null : setting;
    const today = Object.fromEntries(LIMIT_METRICS.map((m) => [m, unknown])) as Record<
      LimitMetric,
      Figure
    >;
    return {
      plan: { setting, detected: null, detection, effective },
      fetchedAt: now,
      resetsAt,
      today,
      last24h: today,
      month: null,
      limits,
      logs: logsReport(sampling, today, today, null),
      debug: [],
    };
  }
  if (!planCache || now - planCache.at >= PLAN_CACHE_MS) {
    planCache = { at: now, value: await detectWorkersPlan(token, accountId, fetchFn) };
  }
  const detected = 'plan' in planCache.value ? planCache.value.plan : null;
  const detection = 'plan' in planCache.value ? null : planCache.value;
  const effective = setting === 'detect' ? detected : setting;
  const plan: PlanInfo = { setting, detected, detection, effective };

  const day = new Date(now).toISOString().slice(0, 10);
  const monthStart = `${day.slice(0, 7)}-01`;
  const key = `${day}|${effective === 'paid'}`;
  if (!figuresCache || figuresCache.key !== key || now - figuresCache.at >= LIMITS_CACHE_MS) {
    const auth = { token, accountId };
    const [today, last24h, month] = await Promise.all([
      readFigures(auth, { window: 'today', since: day }, fetchFn),
      readFigures(
        auth,
        {
          window: 'last24h',
          since: new Date(now - DAY_MS).toISOString(),
          until: new Date(now).toISOString(),
        },
        fetchFn,
      ),
      effective === 'paid'
        ? readFigures(auth, { window: 'month', since: monthStart }, fetchFn)
        : null,
    ]);
    figuresCache = {
      at: now,
      key,
      value: {
        fetchedAt: now,
        resetsAt,
        today: today.figures,
        last24h: last24h.figures,
        month: month
          ? {
              start: monthStart,
              figures: month.figures,
              overageUsd: overageUsd(month.figures, logsFigure(month.figures, sampling)),
            }
          : null,
        limits,
        debug: [...today.traces, ...last24h.traces, ...(month?.traces ?? [])],
      },
    };
  }
  const { today, last24h, month } = figuresCache.value;
  return {
    plan,
    ...figuresCache.value,
    resetsAt,
    logs: logsReport(sampling, today, last24h, month?.figures ?? null),
  };
}

function logsReport(
  sampling: number,
  today: Record<LimitMetric, Figure>,
  last24h: Record<LimitMetric, Figure>,
  month: Record<LimitMetric, Figure> | null,
): LogsEstimate {
  return {
    sampling,
    today: logsFigure(today, sampling),
    last24h: logsFigure(last24h, sampling),
    month: month ? logsFigure(month, sampling) : null,
    freeDaily: LOGS_FREE_DAILY,
    paidMonthly: LOGS_PAID_MONTHLY_INCLUDED,
    paidUsdPerMillion: LOGS_PAID_USD_PER_MILLION,
  };
}
