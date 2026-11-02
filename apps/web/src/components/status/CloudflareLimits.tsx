// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorBodyOf } from '../../api/client.ts';
import {
  LIMIT_CRITICAL_RATIO,
  LIMIT_METRICS,
  LIMIT_WARN_RATIO,
  type LimitFigure,
  type LimitMetric,
  limitsQuery,
  type LimitsReport,
  setWorkersPlan,
  WORKERS_PLANS,
  type WorkersPlanSetting,
} from '../../api/status.ts';
import { translateError } from '../../i18n/errors.ts';
import { DataCard, DataList } from '../data-list.tsx';
import { formatUsd } from '../admin/format.ts';
import { StatusBadge, type StatusTone } from '../StatusBadge.tsx';

/**
 * /admin: the Cloudflare limits this instance can reach. On Workers Free, each
 * daily cap's use today (UTC) and over the last 24 hours: Cloudflare documents a reset at 00:00
 * UTC, but a block has outlasted it, so both are shown; the app stops at 100 %. On Workers Paid,
 * the month so far against the included amounts with the overage at list prices, plus whether
 * today would still fit the free caps. A figure Cloudflare does not give says why, with
 * Cloudflare's own message, and the raw answers are one click away.
 */
export function CloudflareLimits() {
  const { t } = useTranslation();
  const limits = useQuery(limitsQuery);
  return (
    <section className="flex flex-col gap-4" aria-labelledby="cloudflare-limits">
      <div className="flex flex-col gap-1">
        <h2 id="cloudflare-limits" className="text-lg font-semibold">
          {t('admin.limits.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('admin.limits.intro')}</p>
      </div>
      {limits.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{translateError(errorBodyOf(limits.error), t)}</AlertDescription>
        </Alert>
      ) : !limits.data ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <Report data={limits.data} />
      )}
    </section>
  );
}

type State = 'ok' | 'warning' | 'critical' | 'reached';

const STATE_TONE = {
  ok: 'ok',
  warning: 'warning',
  critical: 'failed',
  reached: 'failed',
} as const satisfies Record<State, StatusTone>;

function stateOf(share: number): State {
  if (share >= 1) return 'reached';
  if (share >= LIMIT_CRITICAL_RATIO) return 'critical';
  if (share >= LIMIT_WARN_RATIO) return 'warning';
  return 'ok';
}

function useFormat() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  return { t, locale, number, percent, time };
}

const ROWS: readonly (LimitMetric | 'logEvents')[] = [...LIMIT_METRICS, 'logEvents'];

function Report({ data }: { data: LimitsReport }) {
  const { t, time, locale } = useFormat();
  const paid = data.plan.effective === 'paid';
  return (
    <>
      <Plan data={data} />
      <p className="text-sm text-muted-foreground" data-testid="limits-freshness">
        {[
          paid
            ? t('admin.limits.monthSoFar', { start: data.month?.start ?? '' })
            : t('admin.limits.resets', { time: time.format(data.resetsAt) }),
          t('admin.limits.updated', { time: time.format(data.fetchedAt) }),
        ].join(' · ')}
      </p>
      <DataList
        items={ROWS}
        getKey={(row) => row}
        renderTable={() => (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-auto min-w-44 pl-4">{t('admin.limits.limit')}</TableHead>
                <TableHead className="w-64">
                  {paid ? t('admin.limits.monthUse') : t('admin.limits.todayUse')}
                </TableHead>
                {!paid && <TableHead className="w-64">{t('admin.limits.last24hUse')}</TableHead>}
                {paid && (
                  <>
                    <TableHead className="w-28 text-right">{t('admin.limits.overage')}</TableHead>
                    <TableHead className="hidden w-40 pr-4 text-right md:table-cell">
                      {t('admin.limits.freeToday')}
                    </TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {LIMIT_METRICS.map((metric) => (
                <Row key={metric} metric={metric} data={data} paid={paid} />
              ))}
              <LogsRow data={data} paid={paid} />
            </TableBody>
          </Table>
        )}
        renderCard={(row) => <LimitCard row={row} data={data} paid={paid} />}
      />
      {paid && data.month && (
        <p className="text-sm tabular-nums" data-testid="limits-overage">
          {t('admin.limits.overageTotal', {
            usd: formatUsd(data.month.overageUsd, locale),
          })}
        </p>
      )}
      {!paid && <p className="text-sm text-muted-foreground">{t('admin.limits.freeStops')}</p>}
      <p className="text-sm text-muted-foreground" data-testid="limits-logs-note">
        {t(paid ? 'admin.limits.logs.notePaid' : 'admin.limits.logs.noteFree')}
      </p>
      <RawResponses data={data} />
    </>
  );
}

/** A limit on a phone: the name, then each use as a labelled bar (the table's columns, stacked). */
function LimitCard({
  row,
  data,
  paid,
}: {
  row: LimitMetric | 'logEvents';
  data: LimitsReport;
  paid: boolean;
}) {
  const { t, locale, percent } = useFormat();
  const logs = row === 'logEvents';
  const figure = logs
    ? paid && data.logs.month
      ? data.logs.month
      : data.logs.today
    : paid && data.month
      ? data.month.figures[row]
      : data.today[row];
  const last24h = logs ? data.logs.last24h : data.last24h[row];
  const todayUsed = logs ? data.logs.today.used : data.today[row].used;
  const limit = logs
    ? paid
      ? data.logs.paidMonthly
      : data.logs.freeDaily
    : paid
      ? data.limits.paidMonthly[row]
      : data.limits.freeDaily[row];
  const included = logs ? data.logs.paidMonthly : data.limits.paidMonthly[row];
  const perMillion = logs ? data.logs.paidUsdPerMillion : data.limits.paidUsdPerMillion[row];
  const freeDaily = logs ? data.logs.freeDaily : data.limits.freeDaily[row];
  const over = figure.used === null ? null : Math.max(0, figure.used - included);
  const labelled = (label: string, body: ReactNode) => (
    <div className="mt-2 flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {body}
    </div>
  );
  return (
    <DataCard
      data-metric={row}
      title={logs ? t('admin.limits.logs.name') : t(`admin.limits.metric.${row}`)}
      meta={
        logs
          ? [t('admin.limits.logs.estimated', { sampling: percent.format(data.logs.sampling) })]
          : []
      }
    >
      {labelled(
        paid ? t('admin.limits.monthUse') : t('admin.limits.todayUse'),
        <Usage figure={figure} limit={limit} />,
      )}
      {!paid && labelled(t('admin.limits.last24hUse'), <Usage figure={last24h} limit={limit} />)}
      {paid && (
        <p className="mt-2 text-[0.8125rem] text-muted-foreground tabular-nums">
          {[
            `${t('admin.limits.overage')} ${
              over === null ? '—' : formatUsd((over / 1_000_000) * perMillion, locale)
            }`,
            `${t('admin.limits.freeToday')} ${
              todayUsed === null ? '—' : percent.format(todayUsed / freeDaily)
            }`,
          ].join(' · ')}
        </p>
      )}
    </DataCard>
  );
}

/** Every GraphQL query of the panel and Cloudflare's raw answer, for the platform admin to debug. */
function RawResponses({ data }: { data: LimitsReport }) {
  const { t } = useTranslation();
  if (data.debug.length === 0) return null;
  return (
    <details className="rounded-lg border p-3 text-sm" data-testid="limits-raw">
      <summary className="cursor-pointer text-muted-foreground">
        {t('admin.limits.raw.title', { count: data.debug.length })}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {data.debug.map((trace) => (
          <div key={`${trace.metric}-${trace.window}`} className="flex flex-col gap-1">
            <span className="font-medium">
              {t('admin.limits.raw.entry', {
                metric: t(`admin.limits.metric.${trace.metric}`),
                window: t(`admin.limits.raw.window.${trace.window}`),
                status: trace.status ?? '—',
              })}
            </span>
            <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs break-all whitespace-pre-wrap">
              {`${trace.query}\n${JSON.stringify(trace.variables)}\n\n${trace.response}`}
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}

function Row({ metric, data, paid }: { metric: LimitMetric; data: LimitsReport; paid: boolean }) {
  const { t, locale, percent } = useFormat();
  const figure = paid && data.month ? data.month.figures[metric] : data.today[metric];
  const limit = paid ? data.limits.paidMonthly[metric] : data.limits.freeDaily[metric];
  const today = data.today[metric];
  const over =
    figure.used === null ? null : Math.max(0, figure.used - data.limits.paidMonthly[metric]);
  return (
    <TableRow data-metric={metric}>
      <TableCell className="pl-4 align-top font-medium whitespace-normal">
        {t(`admin.limits.metric.${metric}`)}
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <Usage figure={figure} limit={limit} />
      </TableCell>
      {!paid && (
        <TableCell className="align-top whitespace-normal">
          <Usage figure={data.last24h[metric]} limit={limit} />
        </TableCell>
      )}
      {paid && (
        <>
          <TableCell className="text-right align-top tabular-nums">
            {over === null
              ? '—'
              : formatUsd((over / 1_000_000) * data.limits.paidUsdPerMillion[metric], locale)}
          </TableCell>
          <TableCell className="hidden pr-4 text-right align-top tabular-nums md:table-cell">
            {today.used === null ? '—' : percent.format(today.used / data.limits.freeDaily[metric])}
          </TableCell>
        </>
      )}
    </TableRow>
  );
}

/**
 * Workers Logs events: no Cloudflare analytics field counts them, so the API
 * estimates them from the invocations and the deployed sampling rate. Past the free limit
 * Cloudflare keeps 1 % of the logs; nothing in the app stops.
 */
function LogsRow({ data, paid }: { data: LimitsReport; paid: boolean }) {
  const { t, locale, percent } = useFormat();
  const { logs } = data;
  const figure = paid && logs.month ? logs.month : logs.today;
  const limit = paid ? logs.paidMonthly : logs.freeDaily;
  const over = figure.used === null ? null : Math.max(0, figure.used - logs.paidMonthly);
  return (
    <TableRow data-metric="logEvents">
      <TableCell className="pl-4 align-top whitespace-normal">
        <span className="font-medium">{t('admin.limits.logs.name')}</span>
        <span className="block text-sm text-muted-foreground">
          {t('admin.limits.logs.estimated', { sampling: percent.format(logs.sampling) })}
        </span>
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <Usage figure={figure} limit={limit} />
      </TableCell>
      {!paid && (
        <TableCell className="align-top whitespace-normal">
          <Usage figure={logs.last24h} limit={limit} />
        </TableCell>
      )}
      {paid && (
        <>
          <TableCell className="text-right align-top tabular-nums">
            {over === null ? '—' : formatUsd((over / 1_000_000) * logs.paidUsdPerMillion, locale)}
          </TableCell>
          <TableCell className="hidden pr-4 text-right align-top tabular-nums md:table-cell">
            {logs.today.used === null ? '—' : percent.format(logs.today.used / logs.freeDaily)}
          </TableCell>
        </>
      )}
    </TableRow>
  );
}

function Usage({ figure, limit }: { figure: LimitFigure; limit: number }) {
  const { t, number, percent } = useFormat();
  if (figure.used === null) {
    return (
      <div className="flex flex-col gap-0.5 text-sm text-muted-foreground">
        <span>{t('admin.limits.notAvailable', { reason: reasonText(figure, t) })}</span>
        {figure.detail && (
          <span className="font-mono text-xs break-words" data-testid="limits-detail">
            {t('admin.limits.cloudflareSaid', { detail: figure.detail })}
          </span>
        )}
      </div>
    );
  }
  const share = figure.used / limit;
  const state = stateOf(share);
  return (
    <div className="flex flex-col gap-1.5">
      <Progress value={Math.min(100, share * 100)} aria-label={percent.format(share)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm tabular-nums text-muted-foreground">
          {t('admin.limits.usedOf', {
            used: number.format(figure.used),
            limit: number.format(limit),
            share: percent.format(share),
          })}
        </span>
        {state !== 'ok' && (
          <StatusBadge tone={STATE_TONE[state]}>{t(`admin.limits.state.${state}`)}</StatusBadge>
        )}
      </div>
      {figure.empty && (
        <span className="text-xs text-muted-foreground">{t('admin.limits.empty')}</span>
      )}
    </div>
  );
}

function reasonText(
  u: Extract<LimitFigure, { used: null }> | NonNullable<LimitsReport['plan']['detection']>,
  t: TFunction,
): string {
  switch (u.reason) {
    case 'not_configured':
      return t('admin.limits.reason.notConfigured', { missing: u.missing.join(', ') });
    case 'permission':
      return t('admin.limits.reason.permission', { permission: u.permission });
    case 'not_exposed':
      return t('admin.limits.reason.notExposed');
    case 'failed':
      return t('admin.limits.reason.failed');
  }
}

function Plan({ data }: { data: LimitsReport }) {
  const { t } = useTranslation();
  const save = useMutation({ mutationFn: setWorkersPlan });
  const { plan } = data;
  const label =
    plan.effective === null
      ? t('admin.limits.plan.unknown')
      : t(`admin.limits.plan.${plan.effective}`);
  const how =
    plan.setting !== 'detect'
      ? t('admin.limits.plan.chosen')
      : plan.detected !== null
        ? t('admin.limits.plan.detected')
        : plan.detection
          ? t('admin.limits.plan.notDetected', { reason: reasonText(plan.detection, t) })
          : '';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium" data-testid="limits-plan">
          {label}
        </span>
        <span className="text-sm text-muted-foreground">{how}</span>
      </div>
      <Select
        value={plan.setting}
        onValueChange={(value) => save.mutate(value as WorkersPlanSetting)}
        disabled={save.isPending}
      >
        <SelectTrigger className="w-full sm:w-56" aria-label={t('admin.limits.plan.choose')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WORKERS_PLANS.map((p) => (
            <SelectItem key={p} value={p}>
              {t(`admin.limits.plan.option.${p}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {save.isError && (
        <Alert variant="destructive" className="w-full">
          <AlertDescription>{translateError(errorBodyOf(save.error), t)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
