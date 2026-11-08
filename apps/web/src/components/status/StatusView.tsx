// SPDX-License-Identifier: AGPL-3.0-only
import { ChartLineIcon, KeyIcon, WarningIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  STATUS_RANGES,
  type StatusRange,
  type StatusSummary,
  type StatusUnavailable,
} from '../../api/status.ts';
import { formatBitrate } from '../../i18n/format.ts';

// The status numbers as the space status tab and the admin overview show them: what
// the viewers got (first frame, freezes, drops), what the helpers sent, and the most frequent
// errors. The targets come from the plan: first frame under 1 s.

export const TTFF_TARGET_MS = 1_000;

export function RangeToggle({
  value,
  onChange,
}: {
  value: StatusRange;
  onChange: (range: StatusRange) => void;
}) {
  const { t } = useTranslation();
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v as StatusRange);
      }}
      aria-label={t('metrics.range.label')}
    >
      {STATUS_RANGES.map((range) => (
        <ToggleGroupItem key={range} value={range}>
          {t(`metrics.range.${range}`)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Why the page has no numbers, and what to do about it. */
export function StatusUnavailableAlert({ status }: { status: StatusUnavailable }) {
  const { t } = useTranslation();
  switch (status.reason) {
    case 'not_configured':
      return (
        <Alert>
          <ChartLineIcon />
          <AlertTitle>{t('metrics.unavailable.notConfigured')}</AlertTitle>
          <AlertDescription>
            {t('metrics.unavailable.notConfiguredHint', { missing: status.missing.join(', ') })}
          </AlertDescription>
        </Alert>
      );
    case 'permission':
      return (
        <Alert>
          <KeyIcon />
          <AlertTitle>{t('metrics.unavailable.permission')}</AlertTitle>
          <AlertDescription>
            {t('metrics.unavailable.permissionHint', { permission: status.permission })}
          </AlertDescription>
        </Alert>
      );
    case 'unavailable':
      return (
        <Alert variant="destructive">
          <WarningIcon />
          <AlertTitle>{t('metrics.unavailable.failed')}</AlertTitle>
          <AlertDescription>{t('metrics.unavailable.failedHint')}</AlertDescription>
        </Alert>
      );
  }
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="eyebrow text-muted-foreground">{label}</dt>
      {children}
    </div>
  );
}

const Value = ({ children, bad = false }: { children: ReactNode; bad?: boolean }) => (
  <dd
    className={
      bad
        ? 'text-2xl font-semibold text-warning tabular-nums'
        : 'text-2xl font-semibold tabular-nums'
    }
  >
    {children}
  </dd>
);
const Note = ({ children }: { children: ReactNode }) => (
  <dd className="text-[0.8125rem] text-muted-foreground tabular-nums">{children}</dd>
);

export function useStatusFormat() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const number = (n: number, digits = 0) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);
  const percent = (fraction: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(fraction);
  const ms = (value: number | null) =>
    value === null ? t('metrics.none') : t('metrics.ms', { value: number(value) });
  return { t, locale, number, percent, ms };
}

/** One range's numbers for a space or the whole instance. */
export function StatusSummaryView({ summary }: { summary: StatusSummary }) {
  const { t, locale, number, percent, ms } = useStatusFormat();
  const { ttff, helper } = summary;
  const empty =
    summary.viewerMinutes === 0 &&
    summary.streamsEnded === 0 &&
    helper.minutes === 0 &&
    ttff.count === 0;
  return (
    <div className="flex flex-col gap-6" data-testid="status-summary">
      {empty && <p className="text-[0.9375rem] text-muted-foreground">{t('metrics.empty')}</p>}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
        <Metric label={t('metrics.ttff')}>
          <Value bad={ttff.medianMs !== null && ttff.medianMs >= TTFF_TARGET_MS}>
            {ms(ttff.medianMs)}
          </Value>
          <Note>{t('metrics.ttffDetail', { p90: ms(ttff.p90Ms), count: ttff.count })}</Note>
          {ttff.prepull.count > 0 && (
            <Note>
              {t('metrics.ttffByStart', {
                prepull: ms(ttff.prepull.medianMs),
                click: ms(ttff.click.medianMs),
              })}
            </Note>
          )}
        </Metric>
        <Metric label={t('metrics.freezes')}>
          <Value>
            {summary.freezesPerHour === null
              ? t('metrics.none')
              : number(summary.freezesPerHour, 1)}
          </Value>
          <Note>{t('metrics.reconnects', { count: summary.reconnects })}</Note>
        </Metric>
        <Metric label={t('metrics.viewerMinutes')}>
          <Value>{number(summary.viewerMinutes)}</Value>
        </Metric>
        <Metric label={t('metrics.drops')}>
          <Value bad={summary.streamsDropped > 0}>
            {summary.dropRate === null ? t('metrics.none') : percent(summary.dropRate)}
          </Value>
          <Note>
            {t('metrics.dropsDetail', {
              dropped: summary.streamsDropped,
              count: summary.streamsEnded,
            })}
          </Note>
        </Metric>
      </dl>
      <div className="grid gap-6 md:grid-cols-2">
        <section className="flex flex-col gap-2" aria-labelledby="status-helpers">
          <h3 id="status-helpers" className="text-base font-medium">
            {t('metrics.helper.title')}
          </h3>
          {helper.minutes === 0 ? (
            <p className="text-[0.9375rem] text-muted-foreground">{t('metrics.helper.none')}</p>
          ) : (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[0.9375rem] tabular-nums">
              <dt className="text-muted-foreground">{t('metrics.helper.minutes')}</dt>
              <dd>{number(helper.minutes)}</dd>
              <dt className="text-muted-foreground">{t('metrics.helper.fps')}</dt>
              <dd>
                {t('metrics.helper.fpsValue', {
                  sent: helper.sentFps === null ? t('metrics.none') : number(helper.sentFps, 1),
                  captured:
                    helper.capturedFps === null ? t('metrics.none') : number(helper.capturedFps, 1),
                })}
              </dd>
              <dt className="text-muted-foreground">{t('metrics.helper.bitrate')}</dt>
              <dd>
                {helper.sentKbps === null
                  ? t('metrics.none')
                  : formatBitrate(helper.sentKbps * 1000, locale)}
              </dd>
              <dt className="text-muted-foreground">{t('metrics.helper.cpu')}</dt>
              <dd>
                {helper.cpuPct === null
                  ? t('metrics.none')
                  : t('metrics.percentOfCore', { value: number(helper.cpuPct, 1) })}
              </dd>
              <dt className="text-muted-foreground">{t('metrics.helper.keyframes')}</dt>
              <dd>
                {helper.keyframeRequestsPerHour === null
                  ? t('metrics.none')
                  : number(helper.keyframeRequestsPerHour, 1)}
              </dd>
              <dt className="text-muted-foreground">{t('metrics.helper.idr')}</dt>
              <dd>
                {helper.idrMaxBytes === null || helper.idrMaxBytes === 0
                  ? t('metrics.none')
                  : t('metrics.kilobytes', { value: number(helper.idrMaxBytes / 1000) })}
              </dd>
            </dl>
          )}
        </section>
        <section className="flex flex-col gap-2" aria-labelledby="status-errors">
          <h3 id="status-errors" className="text-base font-medium">
            {t('metrics.errors.title')}
          </h3>
          {summary.topErrors.length === 0 ? (
            <p className="text-[0.9375rem] text-muted-foreground">{t('metrics.errors.none')}</p>
          ) : (
            <ol className="flex flex-col gap-1 text-[0.9375rem]">
              {summary.topErrors.map((e) => (
                <li key={e.code} className="flex justify-between gap-4">
                  <code className="truncate font-mono text-[0.8125rem]">{e.code}</code>
                  <span className="tabular-nums text-muted-foreground">{number(e.count)}</span>
                </li>
              ))}
            </ol>
          )}
          {summary.decodeErrors > 0 && (
            <p className="text-[0.8125rem] text-muted-foreground">
              {t('metrics.errors.decode', { count: summary.decodeErrors })}
            </p>
          )}
        </section>
        <section className="flex flex-col gap-2" aria-labelledby="status-breaker">
          <h3 id="status-breaker" className="text-base font-medium">
            {t('metrics.breaker.title')}
          </h3>
          {!summary.breakerTrips?.length ? (
            <p className="text-[0.9375rem] text-muted-foreground">{t('metrics.breaker.none')}</p>
          ) : (
            <>
              <p className="text-[0.8125rem] text-muted-foreground">{t('metrics.breaker.hint')}</p>
              <ol className="flex flex-col gap-1 text-[0.9375rem]">
                {summary.breakerTrips.map((b) => (
                  <li key={`${b.object}/${b.cause}`} className="flex justify-between gap-4">
                    <code className="truncate font-mono text-[0.8125rem]">
                      {b.object} · {b.cause}
                    </code>
                    <span className="tabular-nums text-warning">{number(b.count)}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
