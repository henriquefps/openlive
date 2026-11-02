// SPDX-License-Identifier: AGPL-3.0-only
import {
  CaretUpIcon,
  CloudIcon,
  FilmStripIcon,
  type Icon,
  MicrophoneIcon,
  MonitorPlayIcon,
  UsersIcon,
  WalletIcon,
} from '@phosphor-icons/react';
import {
  type EstimateSettings,
  estimateMonth,
  estimateWorkers,
  overheads as overheadsFor,
  type WorkersPlan,
} from '@openlive/usage';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { type PlatformSettings, presetsFor, saveSettings, settingsQuery } from '../../api/admin.ts';
import { errorBodyOf } from '../../api/client.ts';
import {
  limitsQuery,
  setWorkersPlan,
  WORKERS_PLANS,
  type WorkersPlanSetting,
} from '../../api/status.ts';
import {
  DEFAULT_SCENARIO_DRAFT,
  EstimatePanel,
  type EstimatePanelProps,
  EstimateSummary,
  type ScenarioDraft,
  scenarioOf,
} from '../../components/admin/EstimatePanel.tsx';
import {
  AccessFields,
  Av1Fields,
  BudgetFields,
  CameraLimitField,
  StreamFields,
  useSettingsDraft,
} from '../../components/admin/SettingsFields.tsx';
import { platformTrail } from '../../components/breadcrumbs.ts';
import { CapabilityFields } from '../../components/capabilities/CapabilityFields.tsx';
import { Page } from '../../components/Page.tsx';
import { translateError } from '../../i18n/errors.ts';
import { useTutorialScreen } from '../../tutorial/context.ts';

/**
 * /admin/settings: the platform ceilings, the monthly limit, access and the Workers plan in
 * sections, beside an estimate that follows every edit before it is saved. Wide screens: a section
 * list, the form and a sticky estimate; narrower ones a section switcher, and on phones the
 * estimate is a bottom bar that opens a sheet.
 */
export function AdminSettingsPage() {
  const { t } = useTranslation();
  const settings = useQuery(settingsQuery);
  useTutorialScreen('admin-settings', settings.isSuccess);
  const trail = platformTrail(t, 'settings');
  return (
    <Page
      title={t('admin.settings.title')}
      description={t('admin.settings.intro')}
      breadcrumbs={trail}
    >
      {settings.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{translateError(errorBodyOf(settings.error), t)}</AlertDescription>
        </Alert>
      ) : settings.data ? (
        <SettingsForm initial={settings.data} />
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
    </Page>
  );
}

const SECTIONS = [
  { id: 'streams', icon: MonitorPlayIcon },
  { id: 'av1', icon: FilmStripIcon },
  { id: 'voice', icon: MicrophoneIcon },
  { id: 'budget', icon: WalletIcon },
  { id: 'access', icon: UsersIcon },
  { id: 'cloudflare', icon: CloudIcon },
] as const satisfies { id: string; icon: Icon }[];
type SectionId = (typeof SECTIONS)[number]['id'];

const anchorOf = (id: SectionId) => `settings-${id}`;

function scrollToSection(id: SectionId) {
  document.getElementById(anchorOf(id))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** The section in view, for the section list and switcher (none where IntersectionObserver is not). */
function useSectionInView(): SectionId {
  const [current, setCurrent] = useState<SectionId>(SECTIONS[0].id);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        const top = visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const section = SECTIONS.find((s) => anchorOf(s.id) === top?.target.id);
        if (section) setCurrent(section.id);
      },
      // A section counts once its top passes the upper third of the screen.
      { rootMargin: '-20% 0px -60% 0px' },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(anchorOf(s.id));
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);
  return current;
}

/** The plan the estimate's Workers note uses: the chosen one, or the detected one on "detect". */
function workersPlanOf(
  setting: WorkersPlanSetting | null,
  detected: 'free' | 'paid' | null,
): WorkersPlan | null {
  if (setting === 'free' || setting === 'paid') return setting;
  return detected;
}

function SettingsForm({ initial }: { initial: PlatformSettings }) {
  const { t } = useTranslation();
  const formId = useId();
  const limits = useQuery(limitsQuery);
  const [saved, setSaved] = useState(initial);
  const savedPlan = limits.data?.plan.setting ?? null;
  const [planDraft, setPlanDraft] = useState<WorkersPlanSetting | null>(null);
  const plan = planDraft ?? savedPlan;
  const [scenario, setScenario] = useState<ScenarioDraft>(DEFAULT_SCENARIO_DRAFT);
  const save = useMutation({
    mutationFn: async (input: { values: PlatformSettings; plan: WorkersPlanSetting | null }) => {
      const next = await saveSettings(input.values);
      if (input.plan !== null && input.plan !== savedPlan) await setWorkersPlan(input.plan);
      return next;
    },
    onSuccess: (next) => {
      setSaved(next);
      form.reset(next);
      setPlanDraft(null);
    },
  });
  const form = useSettingsDraft(saved, () => save.reset());
  const { draft, set, values, invalid, hasErrors, ceiling, limitGB } = form;
  const planDirty = planDraft !== null && planDraft !== savedPlan;
  const dirty = form.dirty || planDirty;
  const discard = () => {
    form.reset(saved);
    setPlanDraft(null);
    save.reset();
  };

  // The estimate reads the form as it is now; an invalid field counts at its saved value.
  const presets = presetsFor(values.maxResolution, values.maxFps);
  const estimateSettings: EstimateSettings = {
    presets,
    maxBitrateKbps: ceiling.bitrateMbps * 1000,
    maxViewersPerStream: ceiling.slots,
    maxStreamsPerRoom: invalid.maxStreamsPerRoom
      ? saved.maxStreamsPerRoom
      : values.maxStreamsPerRoom,
    maxCamerasPerRoom: invalid.maxCamerasPerRoom
      ? saved.maxCamerasPerRoom
      : values.maxCamerasPerRoom,
    allowAv1: values.allowAv1,
    presetCodecs: values.presetCodecs,
    capabilities: values.capabilities,
    overheads: overheadsFor(values.overheads),
    limitGB,
    autoEconomy: values.autoEconomy,
  };
  const estimate = estimateMonth(estimateSettings, scenarioOf(scenario));
  const workersPlan = workersPlanOf(plan, limits.data?.plan.detected ?? null);
  const panel: EstimatePanelProps = {
    estimate,
    workers: workersPlan ? estimateWorkers(estimate.applied, workersPlan) : null,
    draft: scenario,
    onChange: setScenario,
    presets,
    av1: values.allowAv1,
  };
  const inView = useSectionInView();
  const fields = { draft, set, invalid };
  const setCapabilities = (next: PlatformSettings['capabilities']) => set('capabilities', next);

  const sections: Record<SectionId, ReactNode> = {
    streams: <StreamFields {...fields} />,
    av1: <Av1Fields draft={draft} set={set} />,
    voice: (
      <>
        <CapabilityFields value={draft.capabilities} onChange={setCapabilities} allowList />
        <CameraLimitField {...fields} />
      </>
    ),
    budget: <BudgetFields {...fields} ceiling={ceiling} />,
    access: <AccessFields draft={draft} set={set} />,
    cloudflare: (
      <WorkersPlanField
        value={plan}
        detected={limits.data?.plan.detected ?? null}
        error={limits.isError ? translateError(errorBodyOf(limits.error), t) : null}
        onChange={setPlanDraft}
      />
    ),
  };

  return (
    <div className="@container flex flex-col">
      <div className="grid items-start gap-6 @3xl:grid-cols-[minmax(0,1fr)_20rem] @5xl:grid-cols-[10rem_minmax(0,1fr)_21rem]">
        <nav
          aria-label={t('admin.settings.sections.label')}
          className="sticky top-[calc(var(--header-height)+1.5rem)] hidden @5xl:block"
          data-testid="settings-nav"
        >
          <ul className="flex flex-col gap-0.5">
            {SECTIONS.map(({ id, icon: SectionIcon }) => (
              <li key={id}>
                <a
                  href={`#${anchorOf(id)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    scrollToSection(id);
                  }}
                  aria-current={inView === id ? 'location' : undefined}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                    'aria-[current=location]:bg-muted aria-[current=location]:font-medium aria-[current=location]:text-foreground',
                  )}
                >
                  <SectionIcon />
                  {t(`admin.settings.sections.${id}.title`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <form
          id={formId}
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!hasErrors) save.mutate({ values, plan });
          }}
        >
          <SectionSwitcher current={inView} />
          {SECTIONS.map(({ id, icon: SectionIcon }) => (
            <Card
              key={id}
              id={anchorOf(id)}
              className="scroll-mt-[calc(var(--header-height)+4.5rem)] @5xl:scroll-mt-[calc(var(--header-height)+1.5rem)]"
              data-testid={`section-${id}`}
              data-tour={id === 'voice' ? 'admin-settings-capabilities' : undefined}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <SectionIcon className="text-muted-foreground" />
                  {t(`admin.settings.sections.${id}.title`)}
                </CardTitle>
                <CardDescription>{t(`admin.settings.sections.${id}.description`)}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-6">{sections[id]}</CardContent>
            </Card>
          ))}
        </form>

        <aside
          aria-label={t('admin.estimate.title')}
          className="sticky top-[calc(var(--header-height)+1.5rem)] hidden max-h-[calc(100dvh-var(--header-height)-3rem)] overflow-y-auto rounded-xl border bg-card p-4 @3xl:block"
          data-testid="estimate-aside"
        >
          <EstimatePanel {...panel} />
        </aside>
      </div>

      <Dock
        formId={formId}
        dirty={dirty}
        hasErrors={hasErrors}
        saving={save.isPending}
        saved={save.isSuccess}
        error={save.isError ? translateError(errorBodyOf(save.error), t) : null}
        onDiscard={discard}
        panel={panel}
      />
    </div>
  );
}

/** Below the wide layout: the sections in a compact menu that stays at the top. */
function SectionSwitcher({ current }: { current: SectionId }) {
  const { t } = useTranslation();
  return (
    <div className="sticky top-(--header-height) z-10 -mx-1 bg-card px-1 py-2 @5xl:hidden">
      <Select value={current} onValueChange={(value) => scrollToSection(value as SectionId)}>
        <SelectTrigger className="w-full" aria-label={t('admin.settings.sections.label')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {SECTIONS.map(({ id }) => (
            <SelectItem key={id} value={id}>
              {t(`admin.settings.sections.${id}.title`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The bar at the bottom of the screen: unsaved changes with Save and Discard (or how the last save
 * went), and on phones the estimate's summary, which opens the full estimate in a sheet.
 */
function Dock({
  formId,
  dirty,
  hasErrors,
  saving,
  saved,
  error,
  onDiscard,
  panel,
}: {
  formId: string;
  dirty: boolean;
  hasErrors: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
  onDiscard: () => void;
  panel: EstimatePanelProps;
}) {
  const { t } = useTranslation();
  const status = dirty || saving || saved || error !== null;
  return (
    <div
      className={cn(
        'sticky bottom-0 z-10 -mx-4 mt-4 flex flex-col border-t bg-card md:-mx-6',
        !status && '@3xl:hidden',
      )}
      data-testid="settings-dock"
    >
      {status && (
        <div
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 md:px-6"
          data-testid="unsaved-bar"
        >
          <div className="min-w-0 text-sm">
            {error !== null ? (
              <FieldError>{error}</FieldError>
            ) : dirty ? (
              <span className="font-medium">{t('admin.settings.unsaved')}</span>
            ) : saved ? (
              <p role="status" className="text-muted-foreground">
                {t('admin.settings.saved')}
              </p>
            ) : null}
          </div>
          {(dirty || saving) && (
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={onDiscard} disabled={saving}>
                {t('admin.settings.discard')}
              </Button>
              <Button type="submit" form={formId} disabled={saving || hasErrors}>
                {saving ? t('admin.settings.saving') : t('admin.settings.save')}
              </Button>
            </div>
          )}
        </div>
      )}
      <Sheet>
        <SheetTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 border-t px-4 py-3 text-left first:border-t-0 hover:bg-muted/50 @3xl:hidden"
            data-testid="estimate-bar"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="eyebrow text-muted-foreground">{t('admin.estimate.title')}</span>
              <EstimateSummary estimate={panel.estimate} />
            </span>
            <span className="flex shrink-0 items-center gap-1 text-sm font-medium">
              {t('admin.estimate.open')}
              <CaretUpIcon />
            </span>
          </button>
        </SheetTrigger>
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto rounded-t-xl">
          <SheetHeader className="sr-only">
            <SheetTitle>{t('admin.estimate.title')}</SheetTitle>
            <SheetDescription>{t('admin.estimate.intro')}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pt-4 pb-6 [&_h2]:pr-8">
            <EstimatePanel {...panel} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** The Workers plan: the limits panel's setting, saved with the rest. */
function WorkersPlanField({
  value,
  detected,
  error,
  onChange,
}: {
  value: WorkersPlanSetting | null;
  detected: 'free' | 'paid' | null;
  error: string | null;
  onChange: (plan: WorkersPlanSetting) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <Field>
      <FieldContent>
        <FieldLabel htmlFor={`${id}-plan`}>{t('admin.limits.plan.choose')}</FieldLabel>
        <FieldDescription>
          {value === 'detect'
            ? detected
              ? t('admin.settings.workersPlan.detected', {
                  plan: t(`admin.limits.plan.${detected}`),
                })
              : t('admin.settings.workersPlan.notDetected')
            : t('admin.settings.workersPlan.description')}
        </FieldDescription>
      </FieldContent>
      {error !== null ? (
        <FieldError>{error}</FieldError>
      ) : value === null ? (
        <Skeleton className="h-9 w-full sm:max-w-72" />
      ) : (
        <Select
          value={value}
          onValueChange={(next) => {
            const plan = WORKERS_PLANS.find((p) => p === next);
            if (plan) onChange(plan);
          }}
        >
          <SelectTrigger id={`${id}-plan`} className="w-full sm:max-w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {WORKERS_PLANS.map((p) => (
              <SelectItem key={p} value={p}>
                {t(`admin.limits.plan.option.${p}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Field>
  );
}
