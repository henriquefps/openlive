// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react';
import {
  DEFAULT_SCENARIO,
  type Estimate,
  type EstimateBreakdown,
  type EstimateScenario,
  FREE_TIER_GB,
  PRICE_USD_PER_GB,
  type QualityPreset,
  type WorkersEstimate,
} from '@openlive/usage';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { StatusBadge } from '../StatusBadge.tsx';
import { formatGigabytes, formatHours, formatUsd } from './format.ts';

// The /admin/settings estimate panel: a month of one group under the settings being edited
// (unsaved ones included), with a scenario the admin plays with. All the math is
// @openlive/usage's estimateMonth and estimateWorkers; this only shows it.

/** The scenario as typed: counts as strings so a field can be emptied, the AV1 share in %. */
export type ScenarioDraft = Record<
  'viewers' | 'streamers' | 'hoursPerDay' | 'daysPerMonth' | 'voicePeople' | 'cameras',
  string
> & { preset: QualityPreset; av1Percent: number };

export const DEFAULT_SCENARIO_DRAFT: ScenarioDraft = {
  viewers: String(DEFAULT_SCENARIO.viewers),
  streamers: String(DEFAULT_SCENARIO.streamers),
  hoursPerDay: String(DEFAULT_SCENARIO.hoursPerDay),
  daysPerMonth: String(DEFAULT_SCENARIO.daysPerMonth),
  voicePeople: String(DEFAULT_SCENARIO.voicePeople),
  cameras: String(DEFAULT_SCENARIO.cameras),
  preset: DEFAULT_SCENARIO.preset,
  av1Percent: Math.round(DEFAULT_SCENARIO.av1Share * 100),
};

export const scenarioOf = (d: ScenarioDraft): EstimateScenario => ({
  viewers: Number(d.viewers),
  streamers: Number(d.streamers),
  hoursPerDay: Number(d.hoursPerDay),
  daysPerMonth: Number(d.daysPerMonth),
  voicePeople: Number(d.voicePeople),
  cameras: Number(d.cameras),
  preset: d.preset,
  av1Share: d.av1Percent / 100,
});

const COUNTS = [
  { key: 'viewers', max: 50, step: 1 },
  { key: 'streamers', max: 20, step: 1 },
  { key: 'hoursPerDay', max: 24, step: 0.5 },
  { key: 'daysPerMonth', max: 31, step: 1 },
  { key: 'voicePeople', max: 50, step: 1 },
  { key: 'cameras', max: 12, step: 1 },
] as const;

const SOURCES = [
  'streamsH264GB',
  'streamsAv1GB',
  'voiceGB',
  'camerasGB',
] as const satisfies (keyof EstimateBreakdown)[];

/** One categorical color per source, in the order of --chart-1..4 (green, teal, amber, violet). */
const SOURCE_COLOR: Record<(typeof SOURCES)[number], string> = {
  streamsH264GB: 'bg-chart-1',
  streamsAv1GB: 'bg-chart-2',
  voiceGB: 'bg-chart-3',
  camerasGB: 'bg-chart-4',
};

function useLocale() {
  const { t, i18n } = useTranslation();
  return { t, locale: i18n.resolvedLanguage ?? i18n.language };
}

/** The headline: GB a month, the cost above the free tier, and whether it fits the limit. */
function Headline({ estimate }: { estimate: Estimate }) {
  const { t, locale } = useLocale();
  const limit = estimate.limitGB;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1">
          <dt className="eyebrow text-muted-foreground">{t('admin.estimate.month')}</dt>
          <dd className="text-2xl font-semibold tabular-nums" data-testid="estimate-total">
            {formatGigabytes(estimate.totalGB, locale, 0)}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="eyebrow text-muted-foreground">{t('admin.estimate.cost')}</dt>
          <dd
            className={cn(
              'text-2xl font-semibold tabular-nums',
              estimate.costUsd > 0 && 'text-warning',
            )}
            data-testid="estimate-cost"
          >
            {formatUsd(estimate.costUsd, locale)}
          </dd>
        </div>
      </dl>
      <p className="text-[0.8125rem] text-muted-foreground">
        {t('admin.estimate.costDetail', {
          free: formatGigabytes(FREE_TIER_GB, locale, 0),
          price: formatUsd(PRICE_USD_PER_GB, locale),
        })}
      </p>
      <div className="flex flex-col gap-1.5" data-testid="estimate-fit">
        <StatusBadge tone={estimate.fits ? 'ok' : 'warning'} className="self-start">
          {limit === null
            ? t('admin.estimate.unlimited')
            : estimate.fits
              ? t('admin.estimate.fits', { limit: formatGigabytes(limit, locale, 0) })
              : t('admin.estimate.over', { limit: formatGigabytes(limit, locale, 0) })}
        </StatusBadge>
        <p className="text-sm text-muted-foreground tabular-nums">
          {t(limit === null ? 'admin.estimate.hoursFitFree' : 'admin.estimate.hoursFit', {
            hours: formatHours(estimate.hoursPerDayThatFit, locale),
          })}
        </p>
        {estimate.economy && (
          <p className="text-sm text-muted-foreground" data-testid="estimate-economy">
            {t('admin.estimate.economy', {
              at: formatGigabytes(estimate.economy.startsAtGB, locale, 0),
              total: formatGigabytes(estimate.economy.totalGB, locale, 0),
            })}
          </p>
        )}
      </div>
    </div>
  );
}

/** GB a month by source as small bars on one scale, the largest full width. */
function Breakdown({ estimate }: { estimate: Estimate }) {
  const { t, locale } = useLocale();
  const largest = Math.max(...SOURCES.map((s) => estimate.breakdown[s]));
  return (
    <section className="flex flex-col gap-2" aria-labelledby="estimate-breakdown">
      <h3 id="estimate-breakdown" className="text-sm font-medium">
        {t('admin.estimate.breakdown')}
      </h3>
      <ul className="flex flex-col gap-2" data-testid="estimate-breakdown">
        {SOURCES.map((source) => {
          const gb = estimate.breakdown[source];
          return (
            <li key={source} className="flex flex-col gap-1" data-testid={`estimate-${source}`}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn('size-2 shrink-0 rounded-full', SOURCE_COLOR[source])}
                  />
                  {t(`admin.estimate.source.${source}`)}
                </span>
                <span className="tabular-nums">{formatGigabytes(gb, locale)}</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted" aria-hidden>
                <div
                  className={cn('h-full rounded-full', SOURCE_COLOR[source])}
                  style={{ width: `${largest > 0 ? (gb / largest) * 100 : 0}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What the settings cut from the scenario, so a lower number is explained. */
function Clamps({ estimate }: { estimate: Estimate }) {
  const { t } = useLocale();
  if (estimate.clamped.length === 0) return null;
  const { applied } = estimate;
  return (
    <ul
      className="flex flex-col gap-1 text-[0.8125rem] text-muted-foreground"
      data-testid="estimate-clamps"
    >
      {estimate.clamped.map((c) => (
        <li key={c}>
          {t(`admin.estimate.clamped.${c}`, {
            viewers: applied.viewers,
            streamers: applied.streamers,
            cameras: applied.cameras,
            preset: t(`presets.${applied.preset}`),
          })}
        </li>
      ))}
    </ul>
  );
}

/** Durable Objects against the Workers plan, from the measured group hour. */
function WorkersNote({ workers }: { workers: WorkersEstimate }) {
  const { t, locale } = useLocale();
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  return (
    <p className="text-[0.8125rem] text-muted-foreground" data-testid="estimate-workers">
      {workers.plan === 'free'
        ? t('admin.estimate.workers.free', {
            rows: number.format(workers.rowsWrittenPerDay),
            requests: number.format(workers.requestsPerDay),
            share: percent.format(workers.share),
          })
        : t('admin.estimate.workers.paid', {
            share: percent.format(workers.share),
            usd: formatUsd(workers.overageUsd, locale),
          })}
    </p>
  );
}

/** The scenario the admin plays with. */
function ScenarioFields({
  draft,
  onChange,
  presets,
  av1,
}: {
  draft: ScenarioDraft;
  onChange: (next: ScenarioDraft) => void;
  presets: readonly QualityPreset[];
  /** AV1 is allowed: show the share of viewers that decode it. */
  av1: boolean;
}) {
  const { t } = useLocale();
  const id = useId();
  const preset = presets.includes(draft.preset) ? draft.preset : presets[presets.length - 1];
  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${id}-scenario`}>
      <div className="flex items-center justify-between gap-2">
        <h3 id={`${id}-scenario`} className="text-sm font-medium">
          {t('admin.estimate.scenario')}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(DEFAULT_SCENARIO_DRAFT)}
        >
          <ArrowCounterClockwiseIcon data-icon="inline-start" />
          {t('admin.estimate.resetScenario')}
        </Button>
      </div>
      <FieldGroup className="grid grid-cols-2 gap-3">
        {COUNTS.map(({ key, max, step }) => (
          <Field key={key} className="gap-1.5">
            <FieldLabel htmlFor={`${id}-${key}`}>{t(`admin.estimate.input.${key}`)}</FieldLabel>
            <Input
              id={`${id}-${key}`}
              type="number"
              inputMode="decimal"
              min={0}
              max={max}
              step={step}
              value={draft[key]}
              onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
            />
          </Field>
        ))}
        <Field className="col-span-2 gap-1.5">
          <FieldLabel htmlFor={`${id}-preset`}>{t('admin.estimate.input.preset')}</FieldLabel>
          <Select
            value={preset}
            onValueChange={(value) => {
              const next = presets.find((p) => p === value);
              if (next) onChange({ ...draft, preset: next });
            }}
          >
            <SelectTrigger id={`${id}-preset`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {presets.map((p) => (
                <SelectItem key={p} value={p}>
                  {t(`presets.${p}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {av1 && (
          <Field className="col-span-2 gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <FieldLabel id={`${id}-av1-label`}>{t('admin.estimate.input.av1Share')}</FieldLabel>
              <span className="text-sm tabular-nums" data-testid="estimate-av1-share">
                {draft.av1Percent} %
              </span>
            </div>
            <Slider
              aria-labelledby={`${id}-av1-label`}
              min={0}
              max={100}
              step={5}
              value={[draft.av1Percent]}
              onValueChange={([value]) => onChange({ ...draft, av1Percent: value ?? 0 })}
            />
          </Field>
        )}
      </FieldGroup>
    </section>
  );
}

export interface EstimatePanelProps {
  estimate: Estimate;
  /** Null when the Workers plan is unknown: the note is left out. */
  workers: WorkersEstimate | null;
  draft: ScenarioDraft;
  onChange: (next: ScenarioDraft) => void;
  presets: readonly QualityPreset[];
  av1: boolean;
}

/** The whole panel: the right column on wide screens, the bottom sheet on phones. */
export function EstimatePanel({
  estimate,
  workers,
  draft,
  onChange,
  presets,
  av1,
}: EstimatePanelProps) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col gap-5" data-testid="estimate">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{t('admin.estimate.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('admin.estimate.intro')}</p>
      </div>
      <Headline estimate={estimate} />
      <Breakdown estimate={estimate} />
      <Clamps estimate={estimate} />
      {workers && <WorkersNote workers={workers} />}
      <ScenarioFields draft={draft} onChange={onChange} presets={presets} av1={av1} />
    </div>
  );
}

/** One line for the phone's bottom bar: GB a month, the cost, and the fit. */
export function EstimateSummary({ estimate }: { estimate: Estimate }) {
  const { t, locale } = useLocale();
  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
      data-testid="estimate-summary"
    >
      <span className="font-semibold tabular-nums">
        {t('admin.estimate.perMonth', { value: formatGigabytes(estimate.totalGB, locale, 0) })}
      </span>
      <span
        className={cn(
          'tabular-nums',
          estimate.costUsd > 0 ? 'text-warning' : 'text-muted-foreground',
        )}
      >
        {formatUsd(estimate.costUsd, locale)}
      </span>
      {!estimate.fits && <span className="text-warning">{t('admin.estimate.overShort')}</span>}
    </span>
  );
}
