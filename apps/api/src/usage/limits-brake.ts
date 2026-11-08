// SPDX-License-Identifier: AGPL-3.0-only
// The limits monitor and brake. A cron reads today's
// (UTC) Cloudflare figures for every limit in LIMIT_METRICS, and on Workers Paid the month's,
// stores the snapshot in platform_settings, e-mails the platform admins once per level per day,
// and engages the brake when a figure reaches the admin's share. While the brake is engaged the
// Worker refuses everything that would wake a Durable Object (503 / close 1013, the same answer
// as when Cloudflare refuses, with reason `limits_brake`) and the objects that are awake go
// dormant. It releases by itself at the next 00:00 UTC (or the next month on a Paid monthly
// budget), and the platform admin can release or engage it by hand.
//
// The figures are account-wide (every Worker of the Cloudflare account, not only Openlive), which
// is why the brake stops below 100 %: the account's other projects share the same daily limits.
//
// Everything here is pure or takes the database as a parameter; nothing reads secrets.

import {
  FREE_TIER_DAILY,
  LIMIT_METRICS,
  LIMIT_WARN_RATIO,
  type LimitMetric,
  PAID_MONTHLY_INCLUDED,
  PAID_USD_PER_MILLION,
} from './free-tier';
import { type Figure, nextUtcMidnight, type WorkersPlan } from './cloudflare-limits';

/** platform_settings keys: the admin's setting, the brake's state, the snapshot, the alerts sent. */
export const BRAKE_SETTING_KEY = 'limits_brake';
export const BRAKE_STATE_KEY = 'limits_brake_state';
export const SNAPSHOT_KEY = 'limits_snapshot';
export const ALERTS_KEY = 'limits_alerts';

/** The brake engages at this share of a limit unless the admin picks another. */
export const DEFAULT_BRAKE_PERCENT = 80;
export const BRAKE_PERCENT_MIN = 50;
export const BRAKE_PERCENT_MAX = 95;
/** The largest Paid overage a day the admin can set as the brake's cap (USD). */
export const PAID_USD_PER_DAY_MAX = 10_000;
/** The first alert, before the panel's warning (LIMIT_WARN_RATIO, 70 %). */
export const LIMIT_NOTICE_RATIO = 0.5;

export interface BrakeSetting {
  /** Off: the monitor still alerts, but nothing is refused (the panel warns). */
  enabled: boolean;
  /** The share of a limit (whole percent, 50-95) at which the brake engages. */
  percent: number;
  /** Workers Paid only (use beyond the included amounts is billed, never refused). */
  paid: {
    /** Apply `percent` to the month's included amounts (PAID_MONTHLY_INCLUDED). */
    includedShare: boolean;
    /** Also engage when today's overage at list prices reaches this many USD; null: no cap. */
    usdPerDay: number | null;
  };
}

export const DEFAULT_BRAKE_SETTING: BrakeSetting = {
  enabled: true,
  percent: DEFAULT_BRAKE_PERCENT,
  paid: { includedShare: true, usdPerDay: null },
};

/** What engaged the brake: a limit, or the Paid USD-per-day cap. */
export type BrakeMetric = LimitMetric | 'paidUsdPerDay';

export interface BrakeEngagement {
  since: number;
  /** The figure that reached the brake; null when the admin engaged it by hand. */
  metric: BrakeMetric | null;
  /** That figure's share of its limit (or of the USD cap) when it engaged. */
  share: number | null;
  /** `day` releases at the next 00:00 UTC, `month` at the start of the next month (UTC). */
  window: 'day' | 'month';
  /** When it releases by itself. */
  until: number;
  by: 'monitor' | 'admin';
}

export interface BrakeState {
  engaged: BrakeEngagement | null;
  /** After a release by hand, the monitor does not engage again before this (the next 00:00 UTC). */
  releasedUntil: number | null;
}

export const NO_BRAKE: BrakeState = { engaged: null, releasedUntil: null };

/** The figures the monitor stored last (the admin panel shows them without asking Cloudflare). */
export interface LimitsSnapshot {
  fetchedAt: number;
  /** The UTC day of `today`. */
  day: string;
  /** The plan the shares were taken against; null when unknown (compared as Workers Free). */
  plan: WorkersPlan | null;
  today: Record<LimitMetric, Figure>;
  /** Workers Paid: the calendar month so far (UTC). */
  month: {
    start: string;
    figures: Record<LimitMetric, Figure>;
    overageUsd: number;
    /** Today's part of the overage (the brake's USD-per-day cap). */
    todayUsd: number;
  } | null;
  /**
   * The share of each limit the brake compares: today's against the daily free limits, or on
   * Paid the month's against the included amounts. Null when the figure is unknown.
   */
  shares: Record<LimitMetric, number | null>;
}

export interface AlertsSent {
  day: string;
  /** The levels (whole percent) already e-mailed today. */
  sent: number[];
}

export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** The start of the next calendar month (UTC) after `now`. */
export function nextMonthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

// --- Parsing what is stored (platform_settings value_json) ---

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function brakeSettingOf(v: Record<string, unknown>): BrakeSetting {
  const d = DEFAULT_BRAKE_SETTING;
  const percent = num(v['percent']);
  const paid = isObject(v['paid']) ? v['paid'] : {};
  const usd = num(paid['usdPerDay']);
  return {
    enabled: typeof v['enabled'] === 'boolean' ? v['enabled'] : d.enabled,
    percent:
      percent !== null && Number.isInteger(percent) && percent >= BRAKE_PERCENT_MIN
        ? Math.min(BRAKE_PERCENT_MAX, percent)
        : d.percent,
    paid: {
      includedShare:
        typeof paid['includedShare'] === 'boolean' ? paid['includedShare'] : d.paid.includedShare,
      usdPerDay: usd !== null && usd > 0 ? Math.min(PAID_USD_PER_DAY_MAX, usd) : null,
    },
  };
}

const METRICS: readonly BrakeMetric[] = [...LIMIT_METRICS, 'paidUsdPerDay'];

export function brakeStateOf(v: Record<string, unknown>): BrakeState {
  const e = isObject(v['engaged']) ? v['engaged'] : null;
  const since = num(e?.['since']);
  const until = num(e?.['until']);
  const engaged: BrakeEngagement | null =
    e && since !== null && until !== null
      ? {
          since,
          metric: METRICS.includes(e['metric'] as BrakeMetric)
            ? (e['metric'] as BrakeMetric)
            : null,
          share: num(e['share']),
          window: e['window'] === 'month' ? 'month' : 'day',
          until,
          by: e['by'] === 'admin' ? 'admin' : 'monitor',
        }
      : null;
  return { engaged, releasedUntil: num(v['releasedUntil']) };
}

export function alertsSentOf(v: Record<string, unknown>): AlertsSent {
  const sent = Array.isArray(v['sent'])
    ? v['sent'].filter((n): n is number => typeof n === 'number')
    : [];
  return { day: typeof v['day'] === 'string' ? v['day'] : '', sent };
}

// --- The brake's arithmetic ---

/** Whether the brake holds at `now` (it lapses at `until` even before the monitor runs again). */
export function isEngaged(
  state: BrakeState,
  now: number,
): state is BrakeState & {
  engaged: BrakeEngagement;
} {
  return state.engaged !== null && now < state.engaged.until;
}

/** USD beyond the included amounts for one set of figures, at list prices (unknown: nothing). */
function overageOf(used: (m: LimitMetric) => number | null): number {
  let usd = 0;
  for (const m of LIMIT_METRICS) {
    const u = used(m);
    if (u === null) continue;
    usd += (Math.max(0, u - PAID_MONTHLY_INCLUDED[m]) / 1_000_000) * PAID_USD_PER_MILLION[m];
  }
  return usd;
}

/**
 * Workers Paid: today's part of the month's overage, the month's overage minus what it was before
 * today (the included amounts are used up first, so a day that only fills them costs nothing).
 */
export function todayOverageUsd(
  month: Record<LimitMetric, Figure>,
  today: Record<LimitMetric, Figure>,
): number {
  const all = overageOf((m) => month[m].used);
  const before = overageOf((m) => {
    const total = month[m].used;
    const day = today[m].used;
    return total === null ? null : Math.max(0, total - (day ?? 0));
  });
  return Math.max(0, all - before);
}

/** The share of each limit the brake and the alerts compare (see LimitsSnapshot.shares). */
export function sharesOf(
  plan: WorkersPlan | null,
  today: Record<LimitMetric, Figure>,
  month: Record<LimitMetric, Figure> | null,
): Record<LimitMetric, number | null> {
  return Object.fromEntries(
    LIMIT_METRICS.map((m) => {
      const used = plan === 'paid' && month ? month[m].used : today[m].used;
      const limit = plan === 'paid' && month ? PAID_MONTHLY_INCLUDED[m] : FREE_TIER_DAILY[m];
      return [m, used === null ? null : used / limit];
    }),
  ) as Record<LimitMetric, number | null>;
}

/** The limit closest to its end, or null when no figure is known. */
export function worstShare(
  shares: Record<LimitMetric, number | null>,
): { metric: LimitMetric; share: number } | null {
  let worst: { metric: LimitMetric; share: number } | null = null;
  for (const m of LIMIT_METRICS) {
    const share = shares[m];
    if (share !== null && (worst === null || share > worst.share)) worst = { metric: m, share };
  }
  return worst;
}

export type BrakeTrigger = Omit<BrakeEngagement, 'since' | 'by'>;

/**
 * What the snapshot asks of the brake, or null. Workers Free (or an unknown plan, the safe side):
 * any limit's share today at the admin's percent, until the next 00:00 UTC. Workers Paid: the
 * month's share of the included amounts (until next month) and/or today's overage at the USD cap
 * (until the next 00:00 UTC), whichever the admin chose.
 */
export function brakeTrigger(
  snapshot: LimitsSnapshot,
  setting: BrakeSetting,
  now: number,
): BrakeTrigger | null {
  if (!setting.enabled) return null;
  const ratio = setting.percent / 100;
  const worst = worstShare(snapshot.shares);
  const paid = snapshot.plan === 'paid' && snapshot.month !== null;
  if (!paid) {
    return worst && worst.share >= ratio
      ? { ...worst, window: 'day', until: nextUtcMidnight(now) }
      : null;
  }
  if (setting.paid.includedShare && worst && worst.share >= ratio) {
    return { ...worst, window: 'month', until: nextMonthStart(now) };
  }
  const cap = setting.paid.usdPerDay;
  const usd = snapshot.month?.todayUsd ?? 0;
  if (cap !== null && usd >= cap) {
    return {
      metric: 'paidUsdPerDay',
      share: usd / cap,
      window: 'day',
      until: nextUtcMidnight(now),
    };
  }
  return null;
}

/**
 * The brake after a monitor run: an engagement that reached its `until` lapses, a new trigger
 * engages it unless the admin released it today, and an engagement that is still on stays (a
 * longer trigger only moves its release later). `engagedNow` says the run engaged it.
 */
export function nextBrakeState(
  state: BrakeState,
  trigger: BrakeTrigger | null,
  now: number,
): { state: BrakeState; engagedNow: boolean } {
  const releasedUntil =
    state.releasedUntil !== null && now < state.releasedUntil ? state.releasedUntil : null;
  const engaged = isEngaged(state, now) ? state.engaged : null;
  if (engaged) {
    const later =
      trigger && trigger.until > engaged.until
        ? { until: trigger.until, window: trigger.window }
        : {};
    return { state: { engaged: { ...engaged, ...later }, releasedUntil }, engagedNow: false };
  }
  if (trigger && releasedUntil === null) {
    return {
      state: { engaged: { ...trigger, since: now, by: 'monitor' }, releasedUntil: null },
      engagedNow: true,
    };
  }
  return { state: { engaged: null, releasedUntil }, engagedNow: false };
}

/** The admin releases the brake: it stays released until the next 00:00 UTC. */
export function releasedState(now: number): BrakeState {
  return { engaged: null, releasedUntil: nextUtcMidnight(now) };
}

/** The admin engages the brake by hand: until the next 00:00 UTC, or a release. */
export function engagedByHand(now: number): BrakeState {
  return {
    engaged: {
      since: now,
      metric: null,
      share: null,
      window: 'day',
      until: nextUtcMidnight(now),
      by: 'admin',
    },
    releasedUntil: null,
  };
}

/** The levels (whole percent) e-mailed once a day: 50 %, 70 % and the brake's (90 % when off). */
export function alertLevels(setting: BrakeSetting): number[] {
  const brake = setting.enabled ? setting.percent : 90;
  const levels = [LIMIT_NOTICE_RATIO * 100, LIMIT_WARN_RATIO * 100, brake].map(Math.round);
  return [...new Set(levels)].sort((a, b) => a - b);
}

/**
 * The level to e-mail now, or null: the highest level the worst share reached that was not sent
 * today. Lower levels reached at the same time are marked sent with it (one e-mail, not three).
 */
export function alertToSend(
  share: number | null,
  levels: readonly number[],
  sent: AlertsSent,
  day: string,
): { level: number; sent: AlertsSent } | null {
  if (share === null) return null;
  const already = sent.day === day ? sent.sent : [];
  const reached = levels.filter((l) => share * 100 >= l);
  const top = reached[reached.length - 1];
  if (top === undefined || already.includes(top)) return null;
  return { level: top, sent: { day, sent: [...new Set([...already, ...reached])].sort() } };
}

/** Seconds until the brake releases by itself, for Retry-After. */
export function retryAfterSeconds(engaged: BrakeEngagement, now: number): number {
  return Math.max(1, Math.ceil((engaged.until - now) / 1000));
}

// --- D1 ---

/** The stored values the monitor reads, in one query (four rows read at most). */
export async function readBrakeRows(db: D1Database): Promise<{
  setting: BrakeSetting;
  state: BrakeState;
  alerts: AlertsSent;
  snapshot: LimitsSnapshot | null;
  workersPlan: unknown;
}> {
  const { results } = await db
    .prepare(
      `SELECT key, value_json FROM platform_settings WHERE key IN (?, ?, ?, ?, 'workers_plan')`,
    )
    .bind(BRAKE_SETTING_KEY, BRAKE_STATE_KEY, ALERTS_KEY, SNAPSHOT_KEY)
    .all<{ key: string; value_json: string }>();
  const byKey = new Map(results.map((r) => [r.key, parse(r.value_json)]));
  const snapshot = byKey.get(SNAPSHOT_KEY);
  return {
    setting: brakeSettingOf(byKey.get(BRAKE_SETTING_KEY) ?? {}),
    state: brakeStateOf(byKey.get(BRAKE_STATE_KEY) ?? {}),
    alerts: alertsSentOf(byKey.get(ALERTS_KEY) ?? {}),
    snapshot:
      snapshot && typeof snapshot['fetchedAt'] === 'number'
        ? (snapshot as unknown as LimitsSnapshot)
        : null,
    workersPlan: byKey.get('workers_plan')?.['plan'],
  };
}

function parse(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return isObject(v) ? v : {};
  } catch {
    return {};
  }
}

/** An upsert of one platform_settings key (one row written; updated_by null for the monitor). */
export function putSetting(
  db: D1Database,
  key: string,
  value: unknown,
  actorId: string | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO platform_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value), actorId, now);
}

// --- The cached flag the Worker and the objects check ---

/** How long an isolate trusts its copy of the brake's state (a D1 read at most this often). */
export const BRAKE_CACHE_MS = 30_000;

let cache: { at: number; state: BrakeState } | null = null;

/**
 * The brake's state as this isolate last read it, refreshed from D1 at most every
 * BRAKE_CACHE_MS: no D1 read and no Durable Object request per request. A failed read keeps the
 * last state (or none): the brake never stops the app because D1 did not answer.
 */
export async function cachedBrakeState(
  db: D1Database,
  now: number = Date.now(),
  maxAgeMs: number = BRAKE_CACHE_MS,
): Promise<BrakeState> {
  if (cache && now - cache.at < maxAgeMs && now >= cache.at) return cache.state;
  try {
    const row = await db
      .prepare('SELECT value_json FROM platform_settings WHERE key = ?')
      .bind(BRAKE_STATE_KEY)
      .first<{ value_json: string }>();
    cache = { at: now, state: row ? brakeStateOf(parse(row.value_json)) : NO_BRAKE };
  } catch (error) {
    console.warn('limits brake: state read failed', error);
    cache = { at: now, state: cache?.state ?? NO_BRAKE };
  }
  return cache.state;
}

/** After this isolate changed the state (or in tests): the next check reads D1 again. */
export function forgetBrakeState(state?: BrakeState, now: number = Date.now()): void {
  cache = state ? { at: now, state } : null;
}
