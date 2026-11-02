// SPDX-License-Identifier: AGPL-3.0-only
import {
  type Budget,
  BUDGET_PRESETS_GB,
  budgetLimitGB,
  CAMERA_LAYERS,
  cameraHourGB,
  cappedTopKbps,
  CUSTOM_BUDGET_GB,
  FREE_TIER_GB,
  fullStreamHourGB,
  isHighFrameRate,
  limitForUsd,
  maxMonthlyCostUsd,
  overheads as overheadsFor,
  presetSendKbps,
  QUALITY_PRESETS,
  viewerHourGB,
  viewerHourGBFor,
} from '@openlive/usage';
import type { Preset, RoomCapabilities } from '@openlive/protocol';
import { type ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { isValidCapabilities } from '../../lib/capabilities.ts';
import { CapabilityFields } from '../capabilities/CapabilityFields.tsx';
import {
  FRAME_RATES,
  type PlatformSettings,
  PRESET_CODECS,
  presetsFor,
  RESOLUTIONS,
  SETTINGS_BOUNDS,
} from '../../api/admin.ts';
import { formatGigabytes, formatHours, formatMbps, formatUsd } from './format.ts';
import type { CalculatorCeiling } from './CostCalculator.tsx';

// The platform settings form pieces, shared by /admin/settings and
// the onboarding wizard (/admin/setup): the draft, the quality, monthly limit and access cards.

/** The monthly limit radio cards: the free tier, the presets, custom, unlimited. */
export const BUDGET_CHOICES = ['free', '1500', '2000', '5000', 'custom', 'unlimited'] as const;
export type BudgetChoice = (typeof BUDGET_CHOICES)[number];

/** A custom limit starts at 3,000 GB (US$ 100 a month) until the admin types one. */
const DEFAULT_CUSTOM_GB = 3000;

/** The form keeps numbers as typed (strings) so a field can be emptied while editing. */
export interface Draft extends Omit<
  PlatformSettings,
  | 'maxBitrateKbps'
  | 'maxViewersPerStream'
  | 'maxStreamsPerRoom'
  | 'maxCamerasPerRoom'
  | 'cycleResetDay'
  | 'budget'
> {
  maxBitrateMbps: string;
  maxViewersPerStream: string;
  maxStreamsPerRoom: string;
  maxCamerasPerRoom: string;
  cycleResetDay: string;
  budget: BudgetChoice;
  /** The custom limit in GB, and the same limit as a monthly amount in US$. */
  customGB: string;
  customUsd: string;
}

const choiceOf = (b: Budget): BudgetChoice =>
  b.kind === 'preset' ? (String(b.limitGB) as BudgetChoice) : b.kind;

const usdText = (gb: number) => String(Math.round(maxMonthlyCostUsd(gb) * 100) / 100);

const toDraft = (s: PlatformSettings): Draft => {
  const customGB = s.budget.kind === 'custom' ? s.budget.limitGB : DEFAULT_CUSTOM_GB;
  return {
    ...s,
    maxBitrateMbps: String(s.maxBitrateKbps / 1000),
    maxViewersPerStream: String(s.maxViewersPerStream),
    maxStreamsPerRoom: String(s.maxStreamsPerRoom),
    maxCamerasPerRoom: String(s.maxCamerasPerRoom),
    cycleResetDay: String(s.cycleResetDay),
    budget: choiceOf(s.budget),
    customGB: String(customGB),
    customUsd: usdText(customGB),
  };
};

function budgetOf(d: Draft): Budget {
  if (d.budget === 'free' || d.budget === 'unlimited') return { kind: d.budget };
  if (d.budget === 'custom') return { kind: 'custom', limitGB: Number(d.customGB) };
  const preset = BUDGET_PRESETS_GB.find((gb) => String(gb) === d.budget);
  return preset ? { kind: 'preset', limitGB: preset } : { kind: 'free' };
}

const fromDraft = (d: Draft): PlatformSettings => ({
  maxResolution: d.maxResolution,
  maxFps: d.maxFps,
  maxBitrateKbps: Math.round(Number(d.maxBitrateMbps) * 1000),
  maxViewersPerStream: Number(d.maxViewersPerStream),
  maxStreamsPerRoom: Number(d.maxStreamsPerRoom),
  maxCamerasPerRoom: Number(d.maxCamerasPerRoom),
  budget: budgetOf(d),
  quotaMode: d.quotaMode,
  autoEconomy: d.autoEconomy,
  backgroundPause: d.backgroundPause,
  idleCheck: d.idleCheck,
  cycleResetDay: Number(d.cycleResetDay),
  overheads: d.overheads,
  signup: d.signup,
  spaceCreation: d.spaceCreation,
  capabilities: d.capabilities,
  allowAv1: d.allowAv1,
  presetCodecs: d.presetCodecs,
});

/** Key order apart, the same settings (the API may order the keys differently). */
function sameSettings(a: PlatformSettings, b: PlatformSettings): boolean {
  const sorted = (value: unknown): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([x], [y]) => (x < y ? -1 : 1))
            .map(([k, v]) => [k, sorted(v)]),
        )
      : value;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

const within = (value: number, b: { min: number; max: number }) =>
  Number.isFinite(value) && value >= b.min && value <= b.max;

const isCount = (value: number, b: { min: number; max: number }) =>
  Number.isInteger(value) && within(value, b);

export type Invalid = Record<
  | 'maxBitrateMbps'
  | 'maxViewersPerStream'
  | 'maxStreamsPerRoom'
  | 'maxCamerasPerRoom'
  | 'cycleResetDay'
  | 'customGB'
  | 'capabilities',
  boolean
>;

export type SetDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => void;

/** The editable settings, their validation, and the ceiling the calculator should show. */
export function useSettingsDraft(initial: PlatformSettings, onChange?: () => void) {
  const [draft, setDraft] = useState(() => toDraft(initial));
  const set: SetDraft = (key, value) => {
    onChange?.();
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const values = fromDraft(draft);
  /** Start over from `next` (the saved settings), dropping every edit. */
  const reset = (next: PlatformSettings) => setDraft(toDraft(next));
  const invalid: Invalid = {
    maxBitrateMbps: !within(values.maxBitrateKbps, SETTINGS_BOUNDS.maxBitrateKbps),
    maxViewersPerStream: !isCount(values.maxViewersPerStream, SETTINGS_BOUNDS.maxViewersPerStream),
    maxStreamsPerRoom: !isCount(values.maxStreamsPerRoom, SETTINGS_BOUNDS.maxStreamsPerRoom),
    maxCamerasPerRoom: !isCount(values.maxCamerasPerRoom, SETTINGS_BOUNDS.maxCamerasPerRoom),
    cycleResetDay: !isCount(values.cycleResetDay, SETTINGS_BOUNDS.cycleResetDay),
    customGB: draft.budget === 'custom' && !isCount(Number(draft.customGB), CUSTOM_BUDGET_GB),
    capabilities: !isValidCapabilities(draft.capabilities),
  };
  // While a field is invalid the calculator keeps the last saved value.
  const ceiling: CalculatorCeiling = {
    bitrateMbps: invalid.maxBitrateMbps
      ? initial.maxBitrateKbps / 1000
      : values.maxBitrateKbps / 1000,
    slots: invalid.maxViewersPerStream ? initial.maxViewersPerStream : values.maxViewersPerStream,
  };
  return {
    draft,
    set,
    reset,
    values,
    /** Whether the form differs from `initial`. */
    dirty: !sameSettings(values, initial),
    invalid,
    hasErrors: Object.values(invalid).some(Boolean),
    ceiling,
    /** The monthly limit the calculator compares against (the saved one while invalid). */
    limitGB: budgetLimitGB(invalid.customGB ? initial.budget : values.budget),
  };
}

export interface FieldsProps {
  draft: Draft;
  set: SetDraft;
  invalid: Invalid;
}

/** Step 3: resolution and fps, AV1, bitrate, viewers per stream, streams per room, cameras. */
export function QualityCard({ draft, set, invalid }: FieldsProps) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.settings.quality')}</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <StreamFields draft={draft} set={set} invalid={invalid} />
          <Av1Fields draft={draft} set={set} />
          <CameraLimitField draft={draft} set={set} invalid={invalid} />
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

const BITRATE_BOUNDS = {
  min: SETTINGS_BOUNDS.maxBitrateKbps.min / 1000,
  max: SETTINGS_BOUNDS.maxBitrateKbps.max / 1000,
};

type NumberKey =
  'maxBitrateMbps' | 'maxViewersPerStream' | 'maxStreamsPerRoom' | 'maxCamerasPerRoom';

const NUMBERS = {
  maxBitrateMbps: { label: 'maxBitrate', bounds: BITRATE_BOUNDS, step: 0.5 },
  maxViewersPerStream: {
    label: 'maxViewers',
    bounds: SETTINGS_BOUNDS.maxViewersPerStream,
    step: 1,
  },
  maxStreamsPerRoom: { label: 'maxStreams', bounds: SETTINGS_BOUNDS.maxStreamsPerRoom, step: 1 },
  maxCamerasPerRoom: { label: 'maxCameras', bounds: SETTINGS_BOUNDS.maxCamerasPerRoom, step: 1 },
} as const satisfies Record<NumberKey, unknown>;

const STREAM_NUMBERS = ['maxBitrateMbps', 'maxViewersPerStream', 'maxStreamsPerRoom'] as const;
const CAMERAS = 'maxCamerasPerRoom' satisfies NumberKey;

/** A bounded number setting with its range, and anything else it should say below. */
function NumberField({
  name,
  draft,
  set,
  invalid,
  children,
}: FieldsProps & { name: NumberKey; children?: ReactNode }) {
  const { t } = useTranslation();
  const id = useId();
  const { label, bounds, step } = NUMBERS[name];
  return (
    <Field data-invalid={invalid[name] || undefined}>
      <FieldLabel htmlFor={`${id}-${name}`}>{t(`admin.settings.${label}`)}</FieldLabel>
      <Input
        id={`${id}-${name}`}
        type="number"
        inputMode="decimal"
        min={bounds.min}
        max={bounds.max}
        step={step}
        value={draft[name]}
        onChange={(event) => set(name, event.target.value)}
        aria-invalid={invalid[name] || undefined}
        className="sm:max-w-40"
      />
      <FieldDescription>
        {t('admin.settings.range', { min: bounds.min, max: bounds.max })}
      </FieldDescription>
      {children}
    </Field>
  );
}

/** Resolution and fps (with the 120 fps presets), bitrate, viewers per stream, streams per room. */
export function StreamFields({ draft, set, invalid }: FieldsProps) {
  const { t } = useTranslation();
  const id = useId();
  const on = {
    resolution: (value: string) => {
      const resolution = RESOLUTIONS.find((r) => r === value);
      if (resolution) set('maxResolution', resolution);
    },
    fps: (value: string) => {
      const fps = FRAME_RATES.find((f) => String(f) === value);
      if (fps) set('maxFps', fps);
    },
  };
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <Field>
          <FieldLabel htmlFor={`${id}-resolution`}>{t('admin.settings.maxResolution')}</FieldLabel>
          <Select value={draft.maxResolution} onValueChange={on.resolution}>
            <SelectTrigger id={`${id}-resolution`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {RESOLUTIONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-fps`}>{t('admin.settings.maxFps')}</FieldLabel>
          <Select value={String(draft.maxFps)} onValueChange={on.fps}>
            <SelectTrigger id={`${id}-fps`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {FRAME_RATES.map((f) => (
                <SelectItem key={f} value={String(f)}>
                  {t('admin.settings.fps', { fps: f })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <HighFrameRateNote draft={draft} set={set} invalid={invalid} />
      <BitrateCapNote draft={draft} set={set} invalid={invalid} />
      {STREAM_NUMBERS.map((name) => (
        <NumberField key={name} name={name} draft={draft} set={set} invalid={invalid} />
      ))}
    </>
  );
}

/** Cameras on at once in a room, with what they cost. */
export function CameraLimitField({ draft, set, invalid }: FieldsProps) {
  return (
    <NumberField name={CAMERAS} draft={draft} set={set} invalid={invalid}>
      <CameraCostNote overheads={draft.overheads} />
    </NumberField>
  );
}

/**
 * AV1: off by default until measured on real content. When allowed, streams of the
 * presets on an AV1 mode also send their top layer in AV1, which viewers whose browser decodes it
 * pull instead of H.264: saving data or for quality. Each preset shows what an
 * hour of one top-layer viewer costs on H.264 and in each AV1 mode.
 */
export function Av1Fields({ draft, set }: { draft: Draft; set: SetDraft }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const o = overheadsFor(draft.overheads);
  const capKbps = Math.round(Number(draft.maxBitrateMbps) * 1000) || 0;
  const on = {
    allow: (allow: boolean) => set('allowAv1', allow),
    codec: (p: Preset, value: string) => {
      const codec = PRESET_CODECS.find((c) => c === value);
      if (codec) set('presetCodecs', { ...draft.presetCodecs, [p]: codec });
    },
  };
  return (
    <div className="flex flex-col gap-3" data-testid="av1">
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${id}-av1`}>{t('admin.settings.av1.allow')}</FieldLabel>
          <FieldDescription>{t('admin.settings.av1.description')}</FieldDescription>
        </FieldContent>
        <Switch id={`${id}-av1`} checked={draft.allowAv1} onCheckedChange={on.allow} />
      </Field>
      {draft.allowAv1 &&
        presetsFor(draft.maxResolution, draft.maxFps).map((p) => (
          <Field key={p} data-testid={`av1-${p}`}>
            <FieldLabel htmlFor={`${id}-av1-${p}`}>
              {t('admin.settings.av1.preset', { name: t(`presets.${p}`) })}
            </FieldLabel>
            <Select
              value={draft.presetCodecs[p] ?? 'av1Save'}
              onValueChange={(value) => on.codec(p, value)}
            >
              <SelectTrigger id={`${id}-av1-${p}`} className="w-full sm:max-w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {PRESET_CODECS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {t(`admin.settings.av1.codec.${c}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {t(`admin.settings.av1.hint.${draft.presetCodecs[p] ?? 'av1Save'}`)}
            </FieldDescription>
            <FieldDescription>
              {t('admin.settings.av1.cost', {
                h264: formatGigabytes(viewerHourGBFor(p, 'h264', o, capKbps), locale),
                av1Save: formatGigabytes(viewerHourGBFor(p, 'av1', o, capKbps, 'save'), locale),
                av1Quality: formatGigabytes(
                  viewerHourGBFor(p, 'av1', o, capKbps, 'quality'),
                  locale,
                ),
              })}
            </FieldDescription>
          </Field>
        ))}
    </div>
  );
}

/**
 * What cameras cost: 6 cameras among 6 people, on the strip's low
 * layer and with everyone enlarging, with the calculator's formula.
 */
function CameraCostNote({ overheads }: { overheads: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const o = overheadsFor(overheads);
  const hour = (kbps: number) =>
    formatGigabytes(cameraHourGB({ cameras: 6, people: 6, cameraKbps: kbps }, o), locale);
  return (
    <FieldDescription data-testid="camera-cost">
      {t('admin.settings.maxCamerasCost', {
        strip: hour(CAMERA_LAYERS.l.kbps),
        large: hour(CAMERA_LAYERS.h.kbps),
      })}
    </FieldDescription>
  );
}

/** The smallest bitrate limit, in Mbps and in half steps, that lets a send of `kbps` run in full. */
const BITRATE_FIELD = 'maxBitrateMbps' satisfies NumberKey;

const raiseToMbps = (kbps: number): number => Math.ceil(kbps / 500) / 2;

/** One click puts the needed limit in the field; the admin still saves it. */
function RaiseButton({ need, set }: { need: number; set: SetDraft }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const mbps = raiseToMbps(need);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-1 w-fit"
      data-testid="raise-bitrate"
      onClick={() => set(BITRATE_FIELD, String(mbps))}
    >
      {t('admin.settings.raiseTo', { need: formatMbps(mbps, locale) })}
    </Button>
  );
}

/**
 * The allowed presets below 120 fps (native above all) that the maximum bitrate cuts: each says
 * what its top layer gets instead, and offers the limit that lets it run in full.
 */
export function BitrateCapNote({ draft, set, invalid }: FieldsProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  if (invalid.maxBitrateMbps) return null;
  const capKbps = Math.round(Number(draft.maxBitrateMbps) * 1000);
  const capped = presetsFor(draft.maxResolution, draft.maxFps).filter(
    (p) => !isHighFrameRate(p) && presetSendKbps(p, true) > capKbps,
  );
  return (
    <>
      {capped.map((p) => {
        const need = presetSendKbps(p, true);
        return (
          <FieldDescription key={p} className="text-warning" data-testid={`cap-${p}`}>
            {t('admin.settings.presetCapped', {
              name: t(`presets.${p}`),
              cap: formatMbps(capKbps / 1000, locale),
              rate: formatMbps(cappedTopKbps(p, true, capKbps) / 1000, locale),
              full: formatMbps(QUALITY_PRESETS[p].kbps / 1000, locale),
              need: formatMbps(raiseToMbps(need), locale),
            })}
            <RaiseButton need={need} set={set} />
          </FieldDescription>
        );
      })}
    </>
  );
}

/**
 * The 120 fps presets: off until the admin picks 120 fps; then each one
 * the resolution allows, with what it sends, what a viewer costs an hour, and whether the maximum
 * bitrate (which covers every layer and the sound) cuts its top layer, as the 13 Mbps default does.
 */
export function HighFrameRateNote({ draft, set, invalid }: FieldsProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  if (draft.maxFps !== 120) {
    return (
      <FieldDescription data-testid="fps120-off">{t('admin.settings.fps120Off')}</FieldDescription>
    );
  }
  const capKbps = invalid.maxBitrateMbps ? 0 : Math.round(Number(draft.maxBitrateMbps) * 1000);
  const presets = (['game120', 'max120'] as const).filter(
    (p) => p === 'game120' || draft.maxResolution !== '1080p',
  );
  const o = overheadsFor(draft.overheads);
  return (
    <div className="flex flex-col gap-1.5" data-testid="fps120">
      <span className="text-sm font-medium">{t('admin.settings.fps120Title')}</span>
      {presets.map((p) => {
        const need = presetSendKbps(p, true);
        const capped = capKbps > 0 && need > capKbps;
        return (
          <FieldDescription
            key={p}
            className={cn(capped && 'text-warning')}
            data-testid={`fps120-${p}`}
          >
            {t('admin.settings.fps120Preset', {
              name: t(`presets.${p}`),
              rate: formatMbps(need / 1000, locale),
              size: formatGigabytes(viewerHourGB(p, o, capKbps), locale),
            })}
            {capped &&
              ` ${t('admin.settings.fps120Capped', {
                cap: formatMbps(capKbps / 1000, locale),
                rate: formatMbps(cappedTopKbps(p, true, capKbps) / 1000, locale),
                full: formatMbps(QUALITY_PRESETS[p].kbps / 1000, locale),
                need: formatMbps(raiseToMbps(need), locale),
              })}`}
            {capped && <RaiseButton need={need} set={set} />}
          </FieldDescription>
        );
      })}
    </div>
  );
}

/** What one radio card says: the limit, its maximum monthly cost, the full-stream hours it holds. */
function BudgetOption({
  choice,
  id,
  hourGB,
  customGB,
}: {
  choice: BudgetChoice;
  id: string;
  hourGB: number;
  customGB: number | null;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const limit =
    choice === 'free'
      ? FREE_TIER_GB
      : choice === 'custom'
        ? customGB
        : choice === 'unlimited'
          ? null
          : Number(choice);
  const usd = limit === null ? null : maxMonthlyCostUsd(limit);
  return (
    <FieldLabel htmlFor={`${id}-${choice}`}>
      <Field orientation="horizontal" data-testid={`budget-${choice}`}>
        <RadioGroupItem value={choice} id={`${id}-${choice}`} />
        <FieldContent>
          <span className="text-[0.9375rem] font-semibold">
            {choice === 'free' || choice === 'custom' || choice === 'unlimited'
              ? t(`admin.settings.budget.choice.${choice}`)
              : formatGigabytes(Number(choice), locale, 0)}
          </span>
          {choice === 'free' && (
            <span className="text-[0.8125rem] text-muted-foreground">
              {formatGigabytes(FREE_TIER_GB, locale, 0)}
            </span>
          )}
          <FieldDescription>
            {limit === null
              ? t('admin.settings.budget.noCap')
              : usd === 0
                ? t('admin.settings.budget.noCost', { usd: formatUsd(0, locale) })
                : t('admin.settings.budget.maxCost', { usd: formatUsd(usd ?? 0, locale) })}
          </FieldDescription>
          <FieldDescription className="tabular-nums">
            {limit === null
              ? t('admin.settings.budget.hoursUnlimited')
              : hourGB > 0
                ? t('admin.settings.budget.hours', {
                    hours: formatHours(limit / hourGB, locale),
                  })
                : null}
          </FieldDescription>
        </FieldContent>
      </Field>
    </FieldLabel>
  );
}

/**
 * Step 5: the monthly limit, what happens when it is reached, economy mode, the cycle
 * day and the overheads. Each limit shows its maximum cost and how many full-stream hours fit at
 * the platform ceilings, with the calculator's formula.
 */
export function BudgetCard(props: FieldsProps & { ceiling: CalculatorCeiling }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.settings.budget.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <BudgetFields {...props} />
      </CardContent>
    </Card>
  );
}

/** The monthly limit and what happens near and at it, the cycle day, overheads and brakes 5–6. */
export function BudgetFields({
  draft,
  set,
  invalid,
  ceiling,
}: FieldsProps & { ceiling: CalculatorCeiling }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const id = useId();
  const hourGB = fullStreamHourGB(ceiling, overheadsFor(draft.overheads));
  const customGB = Number(draft.customGB);
  const unlimited = draft.budget === 'unlimited';
  const on = {
    budget: (value: string) => {
      const choice = BUDGET_CHOICES.find((c) => c === value);
      if (choice) set('budget', choice);
    },
    customGB: (value: string) => {
      set('customGB', value);
      const gb = Number(value);
      if (value !== '' && Number.isFinite(gb)) set('customUsd', usdText(gb));
    },
    customUsd: (value: string) => {
      set('customUsd', value);
      const usd = Number(value);
      if (value !== '' && Number.isFinite(usd) && usd >= 0) {
        set('customGB', String(Math.round(limitForUsd(usd))));
      }
    },
    quotaMode: (value: string) => {
      if (value === 'block' || value === 'alerts_only') set('quotaMode', value);
    },
    autoEconomy: (checked: boolean) => set('autoEconomy', checked),
    cycleResetDay: (value: string) => set('cycleResetDay', value),
    overheads: (checked: boolean) => set('overheads', checked),
    backgroundPause: (checked: boolean) => set('backgroundPause', checked),
    idleCheck: (checked: boolean) => set('idleCheck', checked),
  };
  return (
    <FieldGroup>
      <Field>
        <FieldDescription>{t('admin.settings.budget.intro')}</FieldDescription>
        <RadioGroup
          value={draft.budget}
          onValueChange={on.budget}
          aria-label={t('admin.settings.budget.title')}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          data-tour="admin-settings-budget"
        >
          {BUDGET_CHOICES.map((choice) => (
            <BudgetOption
              key={choice}
              choice={choice}
              id={id}
              hourGB={hourGB}
              customGB={invalid.customGB ? null : customGB}
            />
          ))}
        </RadioGroup>
      </Field>
      {draft.budget === 'custom' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field data-invalid={invalid.customGB || undefined}>
            <FieldLabel htmlFor={`${id}-custom-gb`}>
              {t('admin.settings.budget.customGB')}
            </FieldLabel>
            <Input
              id={`${id}-custom-gb`}
              type="number"
              inputMode="numeric"
              min={CUSTOM_BUDGET_GB.min}
              max={CUSTOM_BUDGET_GB.max}
              step={1}
              value={draft.customGB}
              onChange={(event) => on.customGB(event.target.value)}
              aria-invalid={invalid.customGB || undefined}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-custom-usd`}>
              {t('admin.settings.budget.customUsd')}
            </FieldLabel>
            <Input
              id={`${id}-custom-usd`}
              type="number"
              inputMode="decimal"
              min={0}
              step={1}
              value={draft.customUsd}
              onChange={(event) => on.customUsd(event.target.value)}
            />
          </Field>
          <FieldDescription className="sm:col-span-2">
            {t('admin.settings.budget.customDescription', {
              min: formatGigabytes(CUSTOM_BUDGET_GB.min, locale, 0),
              max: formatGigabytes(CUSTOM_BUDGET_GB.max, locale, 0),
              free: formatGigabytes(FREE_TIER_GB, locale, 0),
            })}
          </FieldDescription>
        </div>
      )}
      <FieldSeparator />
      {unlimited ? (
        <FieldDescription>{t('admin.settings.budget.unlimitedNote')}</FieldDescription>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-mode`}>{t('admin.settings.quotaMode')}</FieldLabel>
            <Select value={draft.quotaMode} onValueChange={on.quotaMode}>
              <SelectTrigger id={`${id}-mode`} className="w-full sm:max-w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="block">{t('admin.settings.block')}</SelectItem>
                <SelectItem value="alerts_only">{t('admin.settings.alertsOnly')}</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              {draft.quotaMode === 'block'
                ? t('admin.settings.blockDescription')
                : t('admin.settings.alertsDescription')}
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={`${id}-economy`}>{t('admin.settings.autoEconomy')}</FieldLabel>
              <FieldDescription>{t('admin.settings.autoEconomyDescription')}</FieldDescription>
            </FieldContent>
            <Switch
              id={`${id}-economy`}
              checked={draft.autoEconomy}
              onCheckedChange={on.autoEconomy}
            />
          </Field>
        </>
      )}
      <FieldSeparator />
      <Field data-invalid={invalid.cycleResetDay || undefined}>
        <FieldLabel htmlFor={`${id}-day`}>{t('admin.settings.cycleDay')}</FieldLabel>
        <Input
          id={`${id}-day`}
          type="number"
          inputMode="numeric"
          min={SETTINGS_BOUNDS.cycleResetDay.min}
          max={SETTINGS_BOUNDS.cycleResetDay.max}
          value={draft.cycleResetDay}
          onChange={(event) => on.cycleResetDay(event.target.value)}
          aria-invalid={invalid.cycleResetDay || undefined}
          className="sm:max-w-40"
        />
        <FieldDescription>{t('admin.settings.cycleDayDescription')}</FieldDescription>
      </Field>
      <FieldSeparator />
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${id}-overheads`}>{t('admin.settings.overheads')}</FieldLabel>
          <FieldDescription>{t('admin.settings.overheadsDescription')}</FieldDescription>
        </FieldContent>
        <Switch id={`${id}-overheads`} checked={draft.overheads} onCheckedChange={on.overheads} />
      </Field>
      <FieldSeparator />
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${id}-background`}>
            {t('admin.settings.backgroundPause')}
          </FieldLabel>
          <FieldDescription>{t('admin.settings.backgroundPauseDescription')}</FieldDescription>
        </FieldContent>
        <Switch
          id={`${id}-background`}
          checked={draft.backgroundPause}
          onCheckedChange={on.backgroundPause}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${id}-idle`}>{t('admin.settings.idleCheck')}</FieldLabel>
          <FieldDescription>{t('admin.settings.idleCheckDescription')}</FieldDescription>
        </FieldContent>
        <Switch id={`${id}-idle`} checked={draft.idleCheck} onCheckedChange={on.idleCheck} />
      </Field>
    </FieldGroup>
  );
}

/** The room capabilities spaces and rooms on the instance may have. */
export function CapabilitiesCard({ draft, set }: Omit<FieldsProps, 'invalid'>) {
  const { t } = useTranslation();
  const change = (next: RoomCapabilities) => set('capabilities', next);
  return (
    <Card data-tour="admin-settings-capabilities">
      <CardHeader>
        <CardTitle>{t('admin.settings.capabilities')}</CardTitle>
        <CardDescription>{t('admin.settings.capabilitiesDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <CapabilityFields value={draft.capabilities} onChange={change} allowList />
      </CardContent>
    </Card>
  );
}

/** Who may create an account and who may create a space (invite-only and admin-only by default). */
export function AccessCard({ draft, set }: Omit<FieldsProps, 'invalid'>) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.settings.access')}</CardTitle>
      </CardHeader>
      <CardContent>
        <AccessFields draft={draft} set={set} />
      </CardContent>
    </Card>
  );
}

/** The sign-up and space-creation switches. */
export function AccessFields({ draft, set }: Omit<FieldsProps, 'invalid'>) {
  const { t } = useTranslation();
  const id = useId();
  const on = {
    inviteOnly: (checked: boolean) => set('signup', checked ? 'invite_only' : 'open'),
    adminSpaces: (checked: boolean) => set('spaceCreation', checked ? 'admin_only' : 'members'),
  };
  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${id}-signup`}>{t('admin.settings.inviteOnly')}</FieldLabel>
          <FieldDescription>
            {draft.signup === 'invite_only'
              ? t('admin.settings.inviteOnlyOn')
              : t('admin.settings.inviteOnlyOff')}
          </FieldDescription>
        </FieldContent>
        <Switch
          id={`${id}-signup`}
          checked={draft.signup === 'invite_only'}
          onCheckedChange={on.inviteOnly}
        />
      </Field>
      <FieldSeparator />
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${id}-spaces`}>{t('admin.settings.adminSpaces')}</FieldLabel>
          <FieldDescription>
            {draft.spaceCreation === 'admin_only'
              ? t('admin.settings.adminSpacesOn')
              : t('admin.settings.adminSpacesOff')}
          </FieldDescription>
        </FieldContent>
        <Switch
          id={`${id}-spaces`}
          checked={draft.spaceCreation === 'admin_only'}
          onCheckedChange={on.adminSpaces}
        />
      </Field>
    </FieldGroup>
  );
}
