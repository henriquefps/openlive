// SPDX-License-Identifier: AGPL-3.0-only
// The limits monitor's cron run: today's figures (and the month's on Workers Paid)
// from the GraphQL Analytics API, the snapshot stored for the admin panel, the alert e-mails, and
// the brake engaged or released. Its own cost per run: 7 GraphQL queries (14 on Paid), one D1
// query of at most five rows read, and one row written (the snapshot); the brake's state and the
// alerts are written only when they change.

import { emailSender, type EmailLocale, type EmailMessage, matchEmailLocale } from '../auth/email';
import {
  type Figure,
  overageUsd,
  readFigures,
  resolvePlan,
  type WorkersPlanSetting,
} from './cloudflare-limits';
import {
  FREE_TIER_DAILY,
  LIMIT_METRICS,
  type LimitMetric,
  PAID_MONTHLY_INCLUDED,
} from './free-tier';
import {
  ALERTS_KEY,
  alertLevels,
  alertToSend,
  type BrakeSetting,
  type BrakeState,
  BRAKE_STATE_KEY,
  brakeTrigger,
  forgetBrakeState,
  isEngaged,
  type LimitsSnapshot,
  nextBrakeState,
  putSetting,
  readBrakeRows,
  sharesOf,
  SNAPSHOT_KEY,
  todayOverageUsd,
  utcDay,
  worstShare,
} from './limits-brake';

export interface LimitsMonitorEnv {
  DB: D1Database;
  ROOM: Env['ROOM'];
  SPACE: Env['SPACE'];
  USER_HUB: Env['USER_HUB'];
  CLOUDFLARE_API_TOKEN?: string | undefined;
  CLOUDFLARE_ACCOUNT_ID?: string | undefined;
  APP_ORIGIN?: string;
  RESEND_API_KEY?: string | undefined;
  EMAIL_FROM?: string;
}

export type LimitsMonitorResult =
  | { status: 'skipped'; missing: string[]; state: BrakeState }
  | {
      status: 'stored';
      snapshot: LimitsSnapshot;
      state: BrakeState;
      engagedNow: boolean;
      alerted: number | null;
      slept: SleepResult | null;
    };

/** Figure details are cut to this many characters in the snapshot (it is read on every panel load). */
const DETAIL_MAX = 300;

function trim(figures: Record<LimitMetric, Figure>): Record<LimitMetric, Figure> {
  return Object.fromEntries(
    LIMIT_METRICS.map((m) => {
      const f = figures[m];
      return [m, f.used === null && f.detail ? { ...f, detail: f.detail.slice(0, DETAIL_MAX) } : f];
    }),
  ) as Record<LimitMetric, Figure>;
}

/** Reads the figures and builds the snapshot (no D1). */
export async function takeSnapshot(
  config: { token: string; accountId: string },
  planSetting: WorkersPlanSetting,
  now: number,
  fetchFn: typeof fetch = fetch,
): Promise<LimitsSnapshot> {
  const plan = await resolvePlan(config.token, config.accountId, planSetting, now, fetchFn);
  const day = utcDay(now);
  const monthStart = `${day.slice(0, 7)}-01`;
  const paid = plan.effective === 'paid';
  const [today, month] = await Promise.all([
    readFigures(config, { window: 'today', since: day }, fetchFn),
    paid ? readFigures(config, { window: 'month', since: monthStart }, fetchFn) : null,
  ]);
  const monthFigures = month ? trim(month.figures) : null;
  const todayFigures = trim(today.figures);
  return {
    fetchedAt: now,
    day,
    plan: plan.effective,
    today: todayFigures,
    month: monthFigures
      ? {
          start: monthStart,
          figures: monthFigures,
          overageUsd: overageUsd(monthFigures),
          todayUsd: todayOverageUsd(monthFigures, todayFigures),
        }
      : null,
    shares: sharesOf(plan.effective, todayFigures, monthFigures),
  };
}

const planSettingOf = (v: unknown): WorkersPlanSetting =>
  v === 'free' || v === 'paid' ? v : 'detect';

/** One cron run of the monitor. Idempotent: a second run on the same figures changes nothing. */
export async function runLimitsMonitor(
  env: LimitsMonitorEnv,
  now: number,
  fetchFn: typeof fetch = fetch,
): Promise<LimitsMonitorResult> {
  const stored = await readBrakeRows(env.DB);
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId } = env;
  if (!token || !accountId) {
    // Without figures the brake only lapses (by its `until`) or follows the admin's hand.
    const missing = Object.entries({
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    return { status: 'skipped', missing, state: await settle(env, stored.state, now) };
  }
  const snapshot = await takeSnapshot(
    { token, accountId },
    planSettingOf(stored.workersPlan),
    now,
    fetchFn,
  );
  const trigger = brakeTrigger(snapshot, stored.setting, now);
  const next = nextBrakeState(stored.state, trigger, now);
  const writes: D1PreparedStatement[] = [putSetting(env.DB, SNAPSHOT_KEY, snapshot, null, now)];
  if (JSON.stringify(next.state) !== JSON.stringify(stored.state)) {
    writes.push(putSetting(env.DB, BRAKE_STATE_KEY, next.state, null, now));
  }
  // Alerts: the worst share (or the USD cap's) against the day's levels; the brake engaging is
  // always its own e-mail.
  const worst = worstShare(snapshot.shares);
  const usdShare =
    snapshot.plan === 'paid' && stored.setting.paid.usdPerDay !== null && snapshot.month
      ? snapshot.month.todayUsd / stored.setting.paid.usdPerDay
      : null;
  const share = Math.max(worst?.share ?? -1, usdShare ?? -1);
  const levels = alertLevels(stored.setting);
  const alert = alertToSend(share < 0 ? null : share, levels, stored.alerts, snapshot.day);
  let alerted: number | null = null;
  if (alert || next.engagedNow) {
    const level = alert?.level ?? levels[levels.length - 1] ?? 0;
    const sentNow = alert?.sent ?? {
      day: snapshot.day,
      sent: [
        ...new Set([...(stored.alerts.day === snapshot.day ? stored.alerts.sent : []), level]),
      ],
    };
    writes.push(putSetting(env.DB, ALERTS_KEY, sentNow, null, now));
    alerted = level;
  }
  await env.DB.batch(writes);
  forgetBrakeState(next.state, now);
  if (alerted !== null) {
    await sendAlert(env, snapshot, stored.setting, next.state, alerted, now).catch((error) => {
      console.error('limits monitor: alert e-mail failed', error);
    });
  }
  let slept: SleepResult | null = null;
  if (next.engagedNow && next.state.engaged) {
    slept = await sleepLiveObjects(env, next.state.engaged.until, now);
  }
  if (next.engagedNow) {
    console.warn('limits brake engaged', {
      metric: next.state.engaged?.metric,
      share: next.state.engaged?.share,
      until: next.state.engaged?.until,
      slept,
    });
  }
  return {
    status: 'stored',
    snapshot,
    state: next.state,
    engagedNow: next.engagedNow,
    alerted,
    slept,
  };
}

/** Without figures: a lapsed engagement or release is cleared from D1 (written only then). */
async function settle(env: LimitsMonitorEnv, state: BrakeState, now: number): Promise<BrakeState> {
  const next = nextBrakeState(state, null, now).state;
  if (JSON.stringify(next) !== JSON.stringify(state)) {
    await putSetting(env.DB, BRAKE_STATE_KEY, next, null, now).run();
    forgetBrakeState(next, now);
  }
  return next;
}

// --- Putting live objects to sleep ---

/**
 * At most this many objects are told to sleep when the brake engages: each is one Durable Object
 * request, and with the GraphQL queries and the e-mails they stay under the 50 subrequests a
 * Workers Free invocation may make. Anything missed goes dormant by itself: a room checks the
 * brake on its next alarm or message, and the Worker refuses every new connection.
 */
export const SLEEP_LIMITS = { rooms: 20, spaces: 10, hubs: 10 } as const;
/** Objects active this recently are the ones told to sleep. */
export const SLEEP_LOOKBACK_MS = 24 * 60 * 60_000;

export interface SleepResult {
  rooms: number;
  spaces: number;
  hubs: number;
  /** Sockets closed. */
  closed: number;
  failed: number;
}

/**
 * Tells the objects that may be awake to go dormant (close their sockets with 1013 and delete
 * their alarm). Found from D1 state the app already keeps, without waking anything to ask: rooms
 * with a stream started in the last day and quick rooms still open, spaces of those rooms, and
 * the hubs of people seen in the last day. A few D1 rows read and at most 40 DO requests.
 */
export async function sleepLiveObjects(
  env: Pick<LimitsMonitorEnv, 'DB' | 'ROOM' | 'SPACE' | 'USER_HUB'>,
  until: number,
  now: number,
): Promise<SleepResult> {
  const since = now - SLEEP_LOOKBACK_MS;
  const [rooms, spaces, hubs] = await Promise.all([
    env.DB.prepare(
      `SELECT room_id AS id FROM stream_starts WHERE started_at >= ?1
       UNION SELECT id FROM rooms WHERE kind = 'quick' AND archived_at IS NULL
       LIMIT ?2`,
    )
      .bind(since, SLEEP_LIMITS.rooms)
      .all<{ id: string }>(),
    env.DB.prepare(
      `SELECT DISTINCT space_id AS id FROM stream_starts WHERE started_at >= ? LIMIT ?`,
    )
      .bind(since, SLEEP_LIMITS.spaces)
      .all<{ id: string }>(),
    env.DB.prepare(
      `SELECT id FROM users WHERE last_seen_at >= ? AND deleted_at IS NULL
       ORDER BY last_seen_at DESC LIMIT ?`,
    )
      .bind(since, SLEEP_LIMITS.hubs)
      .all<{ id: string }>(),
  ]);
  const result: SleepResult = { rooms: 0, spaces: 0, hubs: 0, closed: 0, failed: 0 };
  const calls: Promise<void>[] = [];
  const call = (kind: 'rooms' | 'spaces' | 'hubs', run: () => Promise<number>) =>
    calls.push(
      run().then(
        (closed) => {
          result[kind] += 1;
          result.closed += closed;
        },
        (error: unknown) => {
          result.failed += 1;
          console.warn('limits brake: an object did not go to sleep', error);
        },
      ),
    );
  for (const { id } of rooms.results) {
    call('rooms', () => env.ROOM.get(env.ROOM.idFromName(id)).brakeSleep(until));
  }
  for (const { id } of spaces.results) {
    call('spaces', () => env.SPACE.get(env.SPACE.idFromName(id)).brakeSleep(until));
  }
  for (const { id } of hubs.results) {
    call('hubs', () => env.USER_HUB.get(env.USER_HUB.idFromName(id)).brakeSleep());
  }
  await Promise.all(calls);
  return result;
}

// --- The alert e-mail ---

const TEXT = {
  en: {
    subject: (pct: string, what: string) => `Openlive: Cloudflare limits at ${pct} (${what})`,
    engagedSubject: (what: string) => `Openlive paused: limits brake engaged (${what})`,
    intro: (pct: string) =>
      `A Cloudflare limit this instance uses reached ${pct}. The figures are for the whole Cloudflare account, all of its Workers, not only Openlive.`,
    engaged: (until: string) =>
      `The limits brake is engaged: rooms, spaces and live connections are paused until ${until} (UTC), or until you release it in the admin panel.`,
    armed: (pct: string) => `The limits brake engages at ${pct}.`,
    off: 'The limits brake is off: nothing stops before Cloudflare does.',
    usd: (usd: string, cap: string) => `Overage today: ${usd} of the ${cap} a day you allowed.`,
    open: 'Open the admin panel',
    footer: 'You get this e-mail once per level per day because you are a platform admin.',
    metric: {
      doRowsWritten: 'Durable Object rows written',
      doRowsRead: 'Durable Object rows read',
      doRequests: 'Durable Object requests',
      doDuration: 'Durable Object duration (GB-s)',
      d1RowsWritten: 'D1 rows written',
      d1RowsRead: 'D1 rows read',
      workerRequests: 'Worker requests',
      paidUsdPerDay: 'overage a day',
    },
    today: 'today (UTC)',
    month: 'this month, of the included amount',
  },
  'pt-BR': {
    subject: (pct: string, what: string) => `Openlive: limites da Cloudflare em ${pct} (${what})`,
    engagedSubject: (what: string) => `Openlive pausado: freio de limites acionado (${what})`,
    intro: (pct: string) =>
      `Um limite da Cloudflare que esta instância usa chegou a ${pct}. Os números são da conta Cloudflare inteira, de todos os Workers dela, não só do Openlive.`,
    engaged: (until: string) =>
      `O freio de limites está acionado: salas, spaces e conexões ao vivo ficam pausados até ${until} (UTC), ou até você liberá-lo no painel de admin.`,
    armed: (pct: string) => `O freio de limites aciona em ${pct}.`,
    off: 'O freio de limites está desligado: nada para antes da Cloudflare.',
    usd: (usd: string, cap: string) => `Excedente hoje: ${usd} dos ${cap} por dia permitidos.`,
    open: 'Abrir o painel de admin',
    footer: 'Você recebe este e-mail uma vez por nível por dia porque é admin da plataforma.',
    metric: {
      doRowsWritten: 'linhas gravadas em Durable Objects',
      doRowsRead: 'linhas lidas em Durable Objects',
      doRequests: 'requisições de Durable Objects',
      doDuration: 'duração de Durable Objects (GB-s)',
      d1RowsWritten: 'linhas gravadas no D1',
      d1RowsRead: 'linhas lidas no D1',
      workerRequests: 'requisições do Worker',
      paidUsdPerDay: 'excedente por dia',
    },
    today: 'hoje (UTC)',
    month: 'neste mês, do valor incluído',
  },
} as const;

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

/** The alert e-mail for one admin. */
export function alertMessage(
  to: string,
  locale: EmailLocale,
  snapshot: LimitsSnapshot,
  setting: BrakeSetting,
  state: BrakeState,
  level: number,
  now: number,
  adminUrl: string,
): EmailMessage {
  const t = TEXT[locale];
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const usd = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' });
  const worst = worstShare(snapshot.shares);
  const engaged = isEngaged(state, now) ? state.engaged : null;
  const what = engaged?.metric ? t.metric[engaged.metric] : worst ? t.metric[worst.metric] : '';
  const subject = engaged ? t.engagedSubject(what) : t.subject(percent.format(level / 100), what);
  const month = snapshot.plan === 'paid' ? snapshot.month : null;
  const paid = month !== null;
  const lines = LIMIT_METRICS.flatMap((m) => {
    const share = snapshot.shares[m];
    if (share === null) return [];
    const used = month ? month.figures[m].used : snapshot.today[m].used;
    const limit = paid ? PAID_MONTHLY_INCLUDED[m] : FREE_TIER_DAILY[m];
    return [
      `${t.metric[m]}: ${number.format(used ?? 0)} / ${number.format(limit)} (${percent.format(share)}) ${paid ? t.month : t.today}`,
    ];
  });
  const until = engaged ? new Date(engaged.until).toISOString().slice(0, 16).replace('T', ' ') : '';
  const status = engaged
    ? t.engaged(until)
    : setting.enabled
      ? t.armed(percent.format(setting.percent / 100))
      : t.off;
  const usdLine =
    month && setting.paid.usdPerDay !== null
      ? [t.usd(usd.format(month.todayUsd), usd.format(setting.paid.usdPerDay))]
      : [];
  const paragraphs = [t.intro(percent.format(level / 100)), status, ...usdLine];
  const text = `${paragraphs.join('\n\n')}\n\n${lines.join('\n')}\n\n${t.open}: ${adminUrl}\n\n${t.footer}\n`;
  const html = `<!doctype html>
<html lang="${locale}"><body style="font-family: Inter, system-ui, sans-serif; color: #1f2317; line-height: 1.5">
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
<p><a href="${escapeHtml(adminUrl)}" style="display: inline-block; padding: 10px 16px; border-radius: 8px; background: #5b6b2f; color: #ffffff; text-decoration: none; font-weight: 600">${escapeHtml(t.open)}</a></p>
<p style="font-size: 13px; color: #5c604f">${escapeHtml(t.footer)}</p>
</body></html>`;
  return { to, subject, text, html };
}

/** E-mails every platform admin with an address (Resend; nothing when no provider is set). */
async function sendAlert(
  env: LimitsMonitorEnv,
  snapshot: LimitsSnapshot,
  setting: BrakeSetting,
  state: BrakeState,
  level: number,
  now: number,
): Promise<number> {
  const sender = emailSender(env as Env);
  if (!sender) {
    console.warn(
      `limits monitor: ${level} % reached, but no e-mail provider is set (RESEND_API_KEY)`,
    );
    return 0;
  }
  const { results } = await env.DB.prepare(
    `SELECT primary_email, locale FROM users
     WHERE is_platform_admin = 1 AND deleted_at IS NULL AND primary_email IS NOT NULL`,
  ).all<{ primary_email: string; locale: string | null }>();
  const adminUrl = `${(env.APP_ORIGIN ?? '').replace(/\/$/, '')}/admin`;
  await Promise.all(
    results.map((r) =>
      sender.send(
        alertMessage(
          r.primary_email,
          matchEmailLocale([r.locale]),
          snapshot,
          setting,
          state,
          level,
          now,
          adminUrl,
        ),
      ),
    ),
  );
  return results.length;
}
