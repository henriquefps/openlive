// SPDX-License-Identifier: AGPL-3.0-only
import { HandPalmIcon, PlayIcon, WarningIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorBodyOf } from '../../api/client.ts';
import {
  type BrakeSetting,
  type BrakeView,
  brakeQuery,
  engageBrake,
  LIMIT_METRICS,
  releaseBrake,
  saveBrakeSetting,
} from '../../api/status.ts';
import { translateError } from '../../i18n/errors.ts';
import { formatUsd } from '../admin/format.ts';
import { StatusBadge } from '../StatusBadge.tsx';

/**
 * /admin: the limits brake. The monitor's last snapshot (stored every 5 minutes,
 * so opening the panel asks Cloudflare nothing), the brake's state with release / engage, and its
 * setting: the share it engages at, the Workers Paid budget, and the off switch.
 */
export function LimitsBrake() {
  const { t } = useTranslation();
  const brake = useQuery(brakeQuery);
  return (
    <section className="flex flex-col gap-4" aria-labelledby="limits-brake">
      <div className="flex flex-col gap-1">
        <h2 id="limits-brake" className="text-lg font-semibold">
          {t('admin.limits.brake.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('admin.limits.brake.intro')}</p>
      </div>
      {brake.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{translateError(errorBodyOf(brake.error), t)}</AlertDescription>
        </Alert>
      ) : !brake.data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <State view={brake.data} />
          <Snapshot view={brake.data} />
          {/* Remounted when the stored setting changes, so the form starts from it. */}
          <Setting key={JSON.stringify(brake.data.setting)} view={brake.data} />
        </>
      )}
    </section>
  );
}

function useFormat() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return { t, locale, percent, dateTime };
}

/** Armed, engaged since (by which figure) or released, with the buttons. */
function State({ view }: { view: BrakeView }) {
  const { t, locale, percent, dateTime } = useFormat();
  const [confirm, setConfirm] = useState(false);
  const release = useMutation({ mutationFn: releaseBrake });
  const engage = useMutation({ mutationFn: engageBrake, onSuccess: () => setConfirm(false) });
  const { engaged, releasedUntil } = view.state;
  const error = release.error ?? engage.error;
  const what = engaged
    ? engaged.metric === null
      ? t('admin.limits.brake.byHand')
      : engaged.metric === 'paidUsdPerDay'
        ? t('admin.limits.brake.byUsd', {
            usd: formatUsd(view.setting.paid.usdPerDay ?? 0, locale),
          })
        : t('admin.limits.brake.byMetric', {
            metric: t(`admin.limits.metric.${engaged.metric}`),
            share: percent.format(engaged.share ?? 0),
          })
    : null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-testid="brake-state">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            {engaged ? (
              <StatusBadge tone="failed">{t('admin.limits.brake.state.engaged')}</StatusBadge>
            ) : !view.setting.enabled ? (
              <StatusBadge tone="warning">{t('admin.limits.brake.state.off')}</StatusBadge>
            ) : releasedUntil !== null ? (
              <StatusBadge tone="warning">{t('admin.limits.brake.state.released')}</StatusBadge>
            ) : (
              <StatusBadge tone="ok">{t('admin.limits.brake.state.armed')}</StatusBadge>
            )}
          </div>
          <span className="text-sm text-muted-foreground">
            {engaged
              ? t('admin.limits.brake.engagedSince', {
                  since: dateTime.format(engaged.since),
                  what,
                  until: dateTime.format(engaged.until),
                })
              : releasedUntil !== null
                ? t('admin.limits.brake.releasedUntil', { until: dateTime.format(releasedUntil) })
                : view.setting.enabled
                  ? t('admin.limits.brake.armedAt', {
                      share: percent.format(view.setting.percent / 100),
                    })
                  : t('admin.limits.brake.offHint')}
          </span>
        </div>
        {engaged ? (
          <Button onClick={() => release.mutate()} disabled={release.isPending}>
            <PlayIcon />
            {t('admin.limits.brake.release')}
          </Button>
        ) : (
          <Button variant="outline" onClick={() => setConfirm(true)} disabled={engage.isPending}>
            <HandPalmIcon />
            {t('admin.limits.brake.engage')}
          </Button>
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateError(errorBodyOf(error), t)}</AlertDescription>
        </Alert>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.limits.brake.engageTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin.limits.brake.engageBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={engage.isPending}
              onClick={(e) => {
                e.preventDefault();
                engage.mutate();
              }}
            >
              {t('admin.limits.brake.engage')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The stored snapshot: each limit's share the brake compares, against its percent. */
function Snapshot({ view }: { view: BrakeView }) {
  const { t, locale, percent, dateTime } = useFormat();
  const { snapshot } = view;
  if (!snapshot) {
    return <p className="text-sm text-muted-foreground">{t('admin.limits.brake.noSnapshot')}</p>;
  }
  const paid = snapshot.plan === 'paid' && snapshot.month !== null;
  const brakeAt = view.setting.percent / 100;
  return (
    <div className="flex flex-col gap-2" data-testid="brake-snapshot">
      <p className="text-sm text-muted-foreground">
        {t(paid ? 'admin.limits.brake.snapshotPaid' : 'admin.limits.brake.snapshotFree', {
          time: dateTime.format(snapshot.fetchedAt),
        })}
      </p>
      <ul className="flex flex-col gap-2">
        {LIMIT_METRICS.map((m) => {
          const share = snapshot.shares[m];
          return (
            <li key={m} className="flex flex-col gap-1" data-metric={m}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>{t(`admin.limits.metric.${m}`)}</span>
                <span className="tabular-nums text-muted-foreground">
                  {share === null ? t('admin.limits.brake.unknown') : percent.format(share)}
                </span>
              </div>
              <Progress
                value={Math.min(100, (share ?? 0) * 100)}
                aria-label={share === null ? undefined : percent.format(share)}
                className={share !== null && share >= brakeAt ? '[&>div]:bg-destructive' : ''}
              />
            </li>
          );
        })}
      </ul>
      {paid && snapshot.month && (
        <p className="text-sm tabular-nums">
          {t('admin.limits.brake.todayUsd', {
            usd: formatUsd(snapshot.month.todayUsd, locale),
            month: formatUsd(snapshot.month.overageUsd, locale),
          })}
        </p>
      )}
      <p className="text-sm text-muted-foreground">{t('admin.limits.brake.accountWide')}</p>
    </div>
  );
}

/** The share it engages at, the Paid budget and the off switch (with its warning). */
function Setting({ view }: { view: BrakeView }) {
  const { t, percent } = useFormat();
  const id = useId();
  const [draft, setDraft] = useState<BrakeSetting>(view.setting);
  const [percentText, setPercentText] = useState(String(view.setting.percent));
  const [usdText, setUsdText] = useState(
    view.setting.paid.usdPerDay === null ? '' : String(view.setting.paid.usdPerDay),
  );
  const [confirmOff, setConfirmOff] = useState(false);
  const save = useMutation({ mutationFn: saveBrakeSetting });
  const { percentMin, percentMax, usdPerDayMax } = view.bounds;
  const pct = Number(percentText);
  const percentValid = Number.isInteger(pct) && pct >= percentMin && pct <= percentMax;
  const usd = usdText.trim() === '' ? null : Number(usdText);
  const usdValid = usd === null || (Number.isFinite(usd) && usd > 0 && usd <= usdPerDayMax);
  const next: BrakeSetting = {
    ...draft,
    percent: percentValid ? pct : draft.percent,
    paid: { ...draft.paid, usdPerDay: usdValid ? usd : draft.paid.usdPerDay },
  };
  const changed = JSON.stringify(next) !== JSON.stringify(view.setting);
  return (
    <form
      className="flex flex-col gap-4 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (percentValid && usdValid) save.mutate(next);
      }}
    >
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={`${id}-enabled`}>{t('admin.limits.brake.enabled')}</FieldLabel>
            <FieldDescription>{t('admin.limits.brake.enabledHint')}</FieldDescription>
          </FieldContent>
          <Switch
            id={`${id}-enabled`}
            checked={draft.enabled}
            onCheckedChange={(on) => {
              if (on) setDraft({ ...draft, enabled: true });
              else setConfirmOff(true);
            }}
          />
        </Field>
        {!draft.enabled && (
          <Alert variant="destructive">
            <WarningIcon />
            <AlertTitle>{t('admin.limits.brake.offTitle')}</AlertTitle>
            <AlertDescription>{t('admin.limits.brake.offWarning')}</AlertDescription>
          </Alert>
        )}
        <Field data-invalid={!percentValid}>
          <FieldLabel htmlFor={`${id}-percent`}>{t('admin.limits.brake.percent')}</FieldLabel>
          <Input
            id={`${id}-percent`}
            type="number"
            inputMode="numeric"
            min={percentMin}
            max={percentMax}
            step={1}
            className="w-28"
            value={percentText}
            aria-invalid={!percentValid}
            onChange={(e) => setPercentText(e.target.value)}
          />
          <FieldDescription>
            {t('admin.limits.brake.percentHint', {
              min: percent.format(percentMin / 100),
              max: percent.format(percentMax / 100),
              levels: view.alertLevels.map((l) => percent.format(l / 100)).join(', '),
            })}
          </FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={`${id}-included`}>
              {t('admin.limits.brake.paidIncluded')}
            </FieldLabel>
            <FieldDescription>{t('admin.limits.brake.paidIncludedHint')}</FieldDescription>
          </FieldContent>
          <Switch
            id={`${id}-included`}
            checked={draft.paid.includedShare}
            onCheckedChange={(on) =>
              setDraft({ ...draft, paid: { ...draft.paid, includedShare: on } })
            }
          />
        </Field>
        <Field data-invalid={!usdValid}>
          <FieldLabel htmlFor={`${id}-usd`}>{t('admin.limits.brake.paidUsd')}</FieldLabel>
          <Input
            id={`${id}-usd`}
            type="number"
            inputMode="decimal"
            min={0}
            max={usdPerDayMax}
            step="0.01"
            className="w-36"
            placeholder={t('admin.limits.brake.paidUsdNone')}
            value={usdText}
            aria-invalid={!usdValid}
            onChange={(e) => setUsdText(e.target.value)}
          />
          <FieldDescription>{t('admin.limits.brake.paidUsdHint')}</FieldDescription>
        </Field>
      </FieldGroup>
      {save.isError && (
        <Alert variant="destructive">
          <AlertDescription>{translateError(errorBodyOf(save.error), t)}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button type="submit" disabled={!changed || !percentValid || !usdValid || save.isPending}>
          {t('admin.limits.brake.save')}
        </Button>
      </div>
      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.limits.brake.offTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin.limits.brake.offWarning')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => setDraft({ ...draft, enabled: false })}
            >
              {t('admin.limits.brake.turnOff')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
