// SPDX-License-Identifier: AGPL-3.0-only
import {
  CAMERA_LAYERS,
  cameraHourGB,
  compareProfiles,
  DEFAULT_MAX_CAMERAS,
  FREE_TIER_GB,
  fullStreamHourGB,
  fullStreamHoursInFreeTier,
  monthlyScenario,
  overheads as overheadsFor,
  REFERENCE_PROFILE_120,
  REFERENCE_PROFILES,
  type Scenario,
} from '@openlive/usage';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatGigabytes, formatHours, formatMbps, formatUsd } from './format.ts';

// The live cost calculator. It calls the same @openlive/usage functions as the
// API's usage meter, so the onboarding estimate and the month's meter never disagree.

export interface CalculatorCeiling {
  bitrateMbps: number;
  /** Viewers per stream. */
  slots: number;
}

type ScenarioField = 'streamsPerDay' | 'hoursPerStream' | 'viewersPerStream' | 'days' | 'cameras';

/** "2 streams a night, 2 h each, 4 viewers, 20 nights". */
const TYPICAL: Record<ScenarioField, string> = {
  streamsPerDay: '2',
  hoursPerStream: '2',
  viewersPerStream: '4',
  days: '20',
  // Cameras are off by default.
  cameras: '0',
};

const SCENARIO_FIELDS: { key: ScenarioField; max: number; step: number }[] = [
  { key: 'streamsPerDay', max: 50, step: 1 },
  { key: 'hoursPerStream', max: 24, step: 0.5 },
  { key: 'viewersPerStream', max: 50, step: 1 },
  { key: 'days', max: 31, step: 1 },
  { key: 'cameras', max: 12, step: 1 },
];

const nonNegative = (value: string): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function CostCalculator({
  ceiling,
  overheads,
  limitGB = FREE_TIER_GB,
  highFrameRate = false,
}: {
  ceiling: CalculatorCeiling;
  overheads: boolean;
  /** The admin's monthly limit; null when unlimited. Defaults to the free tier. */
  limitGB?: number | null;
  /** The 120 fps presets are on: add the 1440p120 reference profile. */
  highFrameRate?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const id = useId();
  const [scenario, setScenario] = useState(TYPICAL);
  const o = overheadsFor(overheads);

  const hourGB = fullStreamHourGB(ceiling, o);
  // Unlimited: how far the free tier goes, since every hour past it is billed.
  const hours = fullStreamHoursInFreeTier(ceiling, o, limitGB ?? FREE_TIER_GB);
  const input: Scenario = {
    streamsPerDay: nonNegative(scenario.streamsPerDay),
    hoursPerStream: nonNegative(scenario.hoursPerStream),
    viewersPerStream: nonNegative(scenario.viewersPerStream),
    days: nonNegative(scenario.days),
    bitrateMbps: ceiling.bitrateMbps,
    cameras: nonNegative(scenario.cameras),
  };
  // One hour of the default camera limit among as many people.
  const cameraHour = (kbps: number) =>
    cameraHourGB(
      { cameras: DEFAULT_MAX_CAMERAS, people: DEFAULT_MAX_CAMERAS, cameraKbps: kbps },
      o,
    );
  const month = monthlyScenario(input, o);
  const references = highFrameRate
    ? [...REFERENCE_PROFILES, REFERENCE_PROFILE_120]
    : REFERENCE_PROFILES;
  const profiles = compareProfiles(o, undefined, references);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.calculator.title')}</CardTitle>
        <CardDescription>{t('admin.calculator.intro')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Metric
            label={t('admin.calculator.fullHour')}
            value={formatGigabytes(hourGB, locale)}
            detail={t('admin.calculator.fullHourDetail', {
              slots: ceiling.slots,
              bitrate: formatMbps(ceiling.bitrateMbps, locale),
            })}
          />
          <Metric
            label={t('admin.calculator.hoursFit')}
            value={Number.isFinite(hours) ? formatHours(hours, locale) : '∞'}
            detail={t(
              limitGB === null || limitGB === FREE_TIER_GB
                ? 'admin.calculator.hoursFitDetail'
                : 'admin.calculator.hoursFitLimit',
              { quota: formatGigabytes(limitGB ?? FREE_TIER_GB, locale) },
            )}
          />
        </dl>

        <section className="flex flex-col gap-3" aria-labelledby={`${id}-scenario`}>
          <div className="flex flex-col gap-1">
            <h3 id={`${id}-scenario`} className="text-[0.9375rem] font-semibold">
              {t('admin.calculator.scenario')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('admin.calculator.scenarioIntro')}</p>
          </div>
          <FieldGroup className="grid grid-cols-2 gap-4 md:grid-cols-5">
            {SCENARIO_FIELDS.map(({ key, max, step }) => (
              <Field key={key}>
                <FieldLabel htmlFor={`${id}-${key}`}>{t(`admin.calculator.${key}`)}</FieldLabel>
                <Input
                  id={`${id}-${key}`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={max}
                  step={step}
                  value={scenario[key]}
                  onChange={(event) => setScenario((s) => ({ ...s, [key]: event.target.value }))}
                />
              </Field>
            ))}
          </FieldGroup>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Metric
              label={t('admin.calculator.total')}
              value={formatGigabytes(month.totalGB, locale)}
            />
            <Metric
              label={t('admin.calculator.aboveFree')}
              value={formatGigabytes(month.gbAboveFree, locale)}
            />
            <Metric
              label={t('admin.calculator.cost')}
              value={formatUsd(month.costUsd, locale)}
              tone={month.costUsd > 0 ? 'warning' : undefined}
            />
          </dl>
          <p className="text-[0.8125rem] text-muted-foreground">
            {t('admin.calculator.camerasHint')}
          </p>
          {limitGB !== null && month.totalGB > limitGB && (
            <p className="text-sm text-warning">
              {t('admin.calculator.overLimit', { limit: formatGigabytes(limitGB, locale, 0) })}
            </p>
          )}
        </section>

        <dl className="grid grid-cols-1 gap-4" data-testid="calculator-cameras">
          <Metric
            label={t('admin.calculator.cameraHour', {
              cameras: DEFAULT_MAX_CAMERAS,
              people: DEFAULT_MAX_CAMERAS,
            })}
            value={formatGigabytes(cameraHour(CAMERA_LAYERS.l.kbps), locale)}
            detail={t('admin.calculator.cameraHourDetail', {
              strip: formatGigabytes(cameraHour(CAMERA_LAYERS.l.kbps), locale),
              large: formatGigabytes(cameraHour(CAMERA_LAYERS.h.kbps), locale),
            })}
          />
        </dl>

        <section className="flex flex-col gap-3" aria-labelledby={`${id}-profiles`}>
          <h3 id={`${id}-profiles`} className="text-[0.9375rem] font-semibold">
            {t('admin.calculator.profiles')}
          </h3>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {profiles.map((p) => {
              const profile = references.find((r) => r.id === p.id);
              if (!profile) return null;
              return (
                <li key={p.id} className="flex flex-col gap-1 rounded-lg border px-4 py-3">
                  <span className="text-[0.9375rem] font-semibold">
                    {t(`admin.calculator.profile.${p.id}`)}
                  </span>
                  <span className="text-[0.8125rem] text-muted-foreground">
                    {t('admin.calculator.profileSpec', {
                      resolution: profile.resolution,
                      fps: profile.fps,
                      bitrate: formatMbps(profile.bitrateMbps, locale),
                      slots: profile.slots,
                    })}
                  </span>
                  <span className="text-base tabular-nums">
                    {t('admin.calculator.perHour', {
                      value: formatGigabytes(p.fullStreamHourGB, locale),
                    })}
                  </span>
                  <span className="text-base tabular-nums">
                    {t('admin.calculator.hoursPerMonth', {
                      value: formatHours(p.fullStreamHoursInFreeTier, locale),
                    })}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'warning' | undefined;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="eyebrow text-muted-foreground">{label}</dt>
      <dd
        className={cn('text-xl font-semibold tabular-nums', tone === 'warning' && 'text-warning')}
      >
        {value}
      </dd>
      {detail && <dd className="text-[0.8125rem] text-muted-foreground">{detail}</dd>}
    </div>
  );
}
