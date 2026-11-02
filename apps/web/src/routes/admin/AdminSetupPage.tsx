// SPDX-License-Identifier: AGPL-3.0-only
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CheckCircleIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldError } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { type PlatformSettings, saveSettings, settingsQuery } from '../../api/admin.ts';
import { meQuery } from '../../api/auth.ts';
import { errorBodyOf } from '../../api/client.ts';
import {
  CHECK_IDS,
  type CheckResult,
  checksQuery,
  ONBOARDING_STEPS,
  onboardingQuery,
  type OnboardingState,
  saveOnboarding,
} from '../../api/onboarding.ts';
import { spaceQuery, spacesQuery } from '../../api/spaces.ts';
import { CostCalculator } from '../../components/admin/CostCalculator.tsx';
import {
  AccessCard,
  QualityCard,
  BudgetCard,
  useSettingsDraft,
} from '../../components/admin/SettingsFields.tsx';
import { platformTrail } from '../../components/breadcrumbs.ts';
import { Page } from '../../components/Page.tsx';
import { StatusBadge, type StatusTone } from '../../components/StatusBadge.tsx';
import { translateError } from '../../i18n/errors.ts';
import { CreateSpaceDialog } from '../SpacesPage.tsx';
import { CreateInviteDialog } from '../space/InvitesTab.tsx';

// /admin/setup: the platform admin's onboarding wizard. Seven steps; every one can be
// skipped for now, and the step is saved so the wizard resumes where it was left.

export const SETUP_STEPS = [
  'account',
  'checks',
  'quality',
  'calculator',
  'quota',
  'access',
  'space',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** Where the self-host guide explains each secret (docs/self-host.md). */
export const SELF_HOST_GUIDE =
  'https://github.com/henriquefps/openlive/blob/main/docs/self-host.md';

export function AdminSetupPage() {
  const { t } = useTranslation();
  const onboarding = useQuery(onboardingQuery);
  const settings = useQuery(settingsQuery);
  const error = onboarding.error ?? settings.error;
  const trail = platformTrail(t, 'setup');
  return (
    <Page title={t('admin.setup.title')} description={t('admin.setup.intro')} breadcrumbs={trail}>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{translateError(errorBodyOf(error), t)}</AlertDescription>
        </Alert>
      ) : onboarding.data && settings.data ? (
        <Wizard initialStep={onboarding.data.step} initialSettings={settings.data} />
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
    </Page>
  );
}

function Wizard({
  initialStep,
  initialSettings,
}: {
  initialStep: number;
  initialSettings: PlatformSettings;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState(Math.min(Math.max(initialStep, 1), ONBOARDING_STEPS));
  const progress = useMutation({
    mutationFn: ({ to, state }: { to: number; state: OnboardingState }) =>
      saveOnboarding(to, state),
  });
  const save = useMutation({ mutationFn: saveSettings });
  const settings = useSettingsDraft(initialSettings, () => save.reset());
  const name: SetupStep = SETUP_STEPS[step - 1] ?? 'account';
  const savesSettings = name === 'quality' || name === 'quota' || name === 'access';
  const busy = progress.isPending || save.isPending;

  const go = (to: number) => {
    setStep(to);
    progress.mutate({ to, state: 'in_progress' });
  };
  const next = async () => {
    if (savesSettings) {
      if (settings.hasErrors) return;
      await save.mutateAsync(settings.values);
    }
    if (step === ONBOARDING_STEPS) {
      await progress.mutateAsync({ to: step, state: 'completed' });
      await navigate({ to: '/admin' });
      return;
    }
    go(step + 1);
  };
  const skip = async () => {
    await progress.mutateAsync({ to: step, state: 'skipped' });
    await navigate({ to: '/admin' });
  };

  return (
    <div className="flex flex-col gap-6">
      <Stepper current={step} />
      <section aria-labelledby="setup-step-title" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="eyebrow text-muted-foreground">
            {t('admin.setup.stepOf', { step, total: ONBOARDING_STEPS })}
          </p>
          <h2 id="setup-step-title" className="text-lg font-semibold">
            {t(`admin.setup.steps.${name}.title`)}
          </h2>
          <p className="text-[0.9375rem] text-muted-foreground">
            {t(`admin.setup.steps.${name}.intro`)}
          </p>
        </div>
        {name === 'account' && <AccountStep />}
        {name === 'checks' && <ChecksStep />}
        {name === 'quality' && (
          <div className="grid items-start gap-4 xl:grid-cols-2">
            <QualityCard draft={settings.draft} set={settings.set} invalid={settings.invalid} />
            <CostCalculator
              ceiling={settings.ceiling}
              overheads={settings.draft.overheads}
              limitGB={settings.limitGB}
              highFrameRate={settings.draft.maxFps === 120}
            />
          </div>
        )}
        {name === 'calculator' && (
          <div className="flex flex-col gap-4">
            <CostWarning />
            <CostCalculator
              ceiling={settings.ceiling}
              overheads={settings.draft.overheads}
              limitGB={settings.limitGB}
              highFrameRate={settings.draft.maxFps === 120}
            />
          </div>
        )}
        {name === 'quota' && (
          <div className="flex max-w-3xl flex-col gap-4">
            <BudgetCard
              draft={settings.draft}
              set={settings.set}
              invalid={settings.invalid}
              ceiling={settings.ceiling}
            />
            <CostWarning />
          </div>
        )}
        {name === 'access' && (
          <div className="max-w-2xl">
            <AccessCard draft={settings.draft} set={settings.set} />
          </div>
        )}
        {name === 'space' && <FirstSpaceStep />}
      </section>

      {(save.isError || progress.isError) && (
        <FieldError>{translateError(errorBodyOf(save.error ?? progress.error), t)}</FieldError>
      )}
      <footer className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center">
        <Button variant="ghost" disabled={busy} onClick={() => void skip()}>
          {t('admin.setup.skip')}
        </Button>
        <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row">
          {step > 1 && (
            <Button variant="outline" disabled={busy} onClick={() => go(step - 1)}>
              {t('admin.setup.back')}
            </Button>
          )}
          <Button
            disabled={busy || (savesSettings && settings.hasErrors)}
            onClick={() => void next()}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {step === ONBOARDING_STEPS ? t('admin.setup.finish') : t('admin.setup.next')}
          </Button>
        </div>
      </footer>
    </div>
  );
}

const stepState = (n: number, current: number) =>
  n < current ? 'done' : n === current ? 'current' : 'todo';

/** The seven steps: a numbered list on wide screens, only the current one's name on phones. */
function Stepper({ current }: { current: number }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('admin.setup.progress')}>
      <ol className="flex gap-1">
        {SETUP_STEPS.map((name, i) => {
          const n = i + 1;
          const state = stepState(n, current);
          return (
            <li
              key={name}
              aria-current={state === 'current' ? 'step' : undefined}
              className="flex min-w-0 flex-1 flex-col gap-2"
            >
              <span
                aria-hidden
                className={cn(
                  'h-1 rounded-full',
                  state === 'todo' ? 'bg-muted' : 'bg-primary',
                  state === 'current' && 'bg-primary/60',
                )}
              />
              <span
                className={cn(
                  'hidden truncate text-sm md:block',
                  state === 'current' ? 'font-medium' : 'text-muted-foreground',
                )}
              >
                {n}. {t(`admin.setup.steps.${name}.short`)}
                {state === 'done' && <span className="sr-only"> ({t('admin.setup.done')})</span>}
              </span>
              <span className="sr-only md:hidden">
                {n}. {t(`admin.setup.steps.${name}.short`)}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function AccountStep() {
  const { t } = useTranslation();
  const me = useQuery(meQuery);
  if (me.data?.user.isPlatformAdmin) {
    return (
      <Alert>
        <CheckCircleIcon className="text-primary" />
        <AlertTitle>{t('admin.setup.account.done')}</AlertTitle>
        <AlertDescription>
          {t('admin.setup.account.doneDetail', { name: me.data.user.displayName })}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert>
      <WarningIcon />
      <AlertTitle>{t('admin.setup.account.todo')}</AlertTitle>
      <AlertDescription>
        <Link to="/admin/claim" className="underline underline-offset-4">
          {t('admin.setup.account.claim')}
        </Link>
      </AlertDescription>
    </Alert>
  );
}

const CHECK_TONE: Record<CheckResult['status'], StatusTone> = {
  ok: 'ok',
  missing: 'warning',
  error: 'failed',
};

function ChecksStep() {
  const { t } = useTranslation();
  const checks = useQuery(checksQuery);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <a
          href={SELF_HOST_GUIDE}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm underline underline-offset-4"
        >
          {t('admin.setup.checks.guide')}
          <ArrowSquareOutIcon aria-hidden />
        </a>
        <Button
          variant="outline"
          disabled={checks.isFetching}
          onClick={() => void checks.refetch()}
        >
          {checks.isFetching ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <ArrowClockwiseIcon data-icon="inline-start" />
          )}
          {t('admin.setup.checks.rerun')}
        </Button>
      </div>
      {checks.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{translateError(errorBodyOf(checks.error), t)}</AlertDescription>
        </Alert>
      ) : (
        <ul
          className="flex flex-col divide-y rounded-xl border"
          aria-labelledby="setup-step-title"
          aria-busy={checks.isPending}
        >
          {CHECK_IDS.map((id) => {
            const result = checks.data?.find((c) => c.id === id);
            return (
              <li key={id} className="flex items-start gap-3 px-4 py-3 md:px-6">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[0.9375rem] font-medium">
                    {t(`admin.setup.checks.items.${id}`)}
                  </span>
                  {result ? (
                    <span className="text-[0.8125rem] text-muted-foreground">
                      {t(`admin.setup.checks.codes.${result.code}`)}
                      {result.missing && result.missing.length > 0 && (
                        <>
                          {' '}
                          <span className="font-mono">{result.missing.join(', ')}</span>
                        </>
                      )}
                    </span>
                  ) : (
                    <Skeleton className="h-4 w-48" />
                  )}
                </div>
                {result && (
                  <StatusBadge tone={CHECK_TONE[result.status]}>
                    {t(`admin.setup.checks.status.${result.status}`)}
                  </StatusBadge>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Decision 24: usage above the free quota is billed, so the warning is not optional. */
function CostWarning() {
  const { t } = useTranslation();
  return (
    <Alert>
      <WarningIcon />
      <AlertTitle>{t('admin.setup.costWarning.title')}</AlertTitle>
      <AlertDescription>{t('admin.setup.costWarning.body')}</AlertDescription>
    </Alert>
  );
}

function FirstSpaceStep() {
  const { t } = useTranslation();
  const spaces = useQuery(spacesQuery);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const spaceId = createdId ?? spaces.data?.find((s) => s.role === 'owner')?.id ?? null;
  const space = useQuery({ ...spaceQuery(spaceId ?? ''), enabled: spaceId !== null });

  if (spaces.isPending || (spaceId !== null && space.isPending)) {
    return <Skeleton className="h-32 w-full" />;
  }
  if (spaceId === null || !space.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.setup.space.createTitle')}</CardTitle>
          <CardDescription>{t('admin.setup.space.createIntro')}</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateSpaceDialog onCreated={(created) => setCreatedId(created.id)} />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.setup.space.ready', { name: space.data.name })}</CardTitle>
        <CardDescription>{t('admin.setup.space.inviteIntro')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <CreateInviteDialog space={space.data} />
        <Button variant="outline" asChild>
          <Link to="/s/$spaceSlug" params={{ spaceSlug: space.data.slug }}>
            {t('admin.setup.space.open')}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
