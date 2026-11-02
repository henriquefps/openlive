// SPDX-License-Identifier: AGPL-3.0-only
import {
  RocketLaunchIcon,
  SlidersHorizontalIcon,
  UserListIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  type Overview,
  overviewQuery,
  setSpaceSuspended,
  type SpaceUsage,
} from '../../api/admin.ts';
import { errorBodyOf } from '../../api/client.ts';
import { type Onboarding, ONBOARDING_STEPS, onboardingQuery } from '../../api/onboarding.ts';
import { formatGigabytes, formatUsd } from '../../components/admin/format.ts';
import { DataCard, DataCardActions, DataList } from '../../components/data-list.tsx';
import { Page } from '../../components/Page.tsx';
import { StatusBadge } from '../../components/StatusBadge.tsx';
import { AdminStatus } from '../../components/status/AdminStatus.tsx';
import { CloudflareLimits } from '../../components/status/CloudflareLimits.tsx';
import { translateError } from '../../i18n/errors.ts';
import { formatDate } from '../../i18n/format.ts';

/**
 * /admin: the billing cycle's usage across spaces, space suspension, and a way
 * to the accounts that belong to no space.
 */
export function AdminOverviewPage() {
  const { t } = useTranslation();
  const overview = useQuery(overviewQuery);
  const onboarding = useQuery(onboardingQuery);
  const setup = onboarding.data;
  // Until the wizard is completed or skipped, /admin opens it.
  if (setup && setup.completedAt === null && setup.skippedAt === null) {
    return <Navigate to="/admin/setup" replace />;
  }
  return (
    <Page
      title={t('admin.overview.title')}
      description={t('admin.overview.intro')}
      actions={
        <Button asChild variant="outline">
          <Link to="/admin/settings">
            <SlidersHorizontalIcon data-icon="inline-start" />
            {t('admin.overview.settings')}
          </Link>
        </Button>
      }
    >
      {setup && setup.completedAt === null && <SetupReminder onboarding={setup} />}
      {overview.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{translateError(errorBodyOf(overview.error), t)}</AlertDescription>
        </Alert>
      ) : overview.data ? (
        <>
          <Summary data={overview.data} />
          <Spaces spaces={overview.data.spaces} />
          <CloudflareLimits />
          <AdminStatus />
          <UnattachedUsers />
        </>
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
    </Page>
  );
}

const REMINDER_KEY = 'openlive.setupReminder.dismissed';

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(REMINDER_KEY) === '1';
  } catch {
    return false;
  }
}

/** A skipped wizard: a reminder until it is completed, dismissible for this browser session. */
function SetupReminder({ onboarding }: { onboarding: Onboarding }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(REMINDER_KEY, '1');
    } catch {
      // Then it comes back on the next visit to this page.
    }
  };
  return (
    <Alert>
      <RocketLaunchIcon />
      <AlertTitle>{t('admin.setup.reminder.title')}</AlertTitle>
      <AlertDescription>
        {t('admin.setup.reminder.body', { step: onboarding.step, total: ONBOARDING_STEPS })}
      </AlertDescription>
      <AlertAction className="flex items-center gap-1">
        <Button asChild variant="outline">
          <Link to="/admin/setup">{t('admin.setup.reminder.resume')}</Link>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('admin.setup.reminder.dismiss')}
          onClick={dismiss}
        >
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  );
}

const LEVEL_TONE = {
  ok: 'default',
  warn_70: 'warning',
  warn_90: 'warning',
  warn_100: 'destructive',
} as const;

function Summary({ data }: { data: Overview }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const { quota, usage, cycle } = data;
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const used =
    quota.quotaGB === null
      ? t('admin.overview.usedNoLimit', { used: formatGigabytes(quota.usedGB, locale, 0) })
      : t('admin.overview.usedOf', {
          used: whole.format(quota.usedGB),
          quota: formatGigabytes(quota.quotaGB, locale, 0),
        });
  // The day the next cycle starts (`end` is exclusive).
  const turnsOver = Date.parse(`${cycle.end}T00:00:00Z`);
  return (
    <section className="flex flex-col gap-3" aria-label={t('admin.overview.summary')}>
      <h2 className="eyebrow text-muted-foreground">{t('admin.overview.summary')}</h2>
      <p className="text-[0.9375rem] tabular-nums" data-testid="quota-strip">
        {[
          used,
          t('admin.overview.strip.soFar', { usd: formatUsd(quota.cost.usd, locale) }),
          t('admin.overview.strip.projected', {
            usd: formatUsd(quota.projection.cost.usd, locale),
          }),
        ].join(' · ')}
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-[repeat(5,minmax(0,max-content))] md:gap-x-0">
        <Metric label={t('admin.overview.used')}>
          <dd className="text-2xl font-semibold tabular-nums">{used}</dd>
          {quota.usedFraction !== null && (
            <dd>
              <Progress
                value={Math.min(100, quota.usedFraction * 100)}
                tone={LEVEL_TONE[quota.level]}
                aria-label={t('admin.overview.used')}
                className="w-40"
              />
            </dd>
          )}
        </Metric>
        <Metric label={t('admin.overview.measured')}>
          <dd className="text-[0.9375rem] tabular-nums">
            {t('admin.overview.estimate', { value: formatGigabytes(usage.estimatedGB, locale) })}
          </dd>
          <dd className="text-[0.9375rem] tabular-nums text-muted-foreground">
            {usage.realGB === null
              ? t('admin.overview.realNone')
              : t('admin.overview.real', { value: formatGigabytes(usage.realGB, locale) })}
          </dd>
        </Metric>
        <Metric label={t('admin.overview.daysLeft')}>
          <dd className="text-2xl font-semibold tabular-nums">
            {t('admin.overview.daysLeftValue', { count: cycle.daysLeft })}
          </dd>
          <dd className="text-[0.8125rem] text-muted-foreground">
            {t('admin.overview.cycleEnds', {
              date: formatDate(turnsOver, locale, { dateStyle: 'medium', timeZone: 'UTC' }),
            })}
          </dd>
        </Metric>
        <Metric label={t('admin.overview.cost')}>
          <dd
            className={
              quota.cost.usd > 0
                ? 'text-2xl font-semibold text-destructive tabular-nums'
                : 'text-2xl font-semibold tabular-nums'
            }
          >
            {formatUsd(quota.cost.usd, locale)}
          </dd>
          <dd className="text-[0.8125rem] text-muted-foreground">
            {quota.cost.gbAboveFree > 0
              ? t('admin.overview.costDetail', {
                  value: formatGigabytes(quota.cost.gbAboveFree, locale),
                })
              : t('admin.overview.withinFree')}
          </dd>
        </Metric>
        <Metric label={t('admin.overview.projected')}>
          <dd
            className={
              quota.projection.cost.usd > 0
                ? 'text-2xl font-semibold text-warning tabular-nums'
                : 'text-2xl font-semibold tabular-nums'
            }
          >
            {formatUsd(quota.projection.cost.usd, locale)}
          </dd>
          <dd className="text-[0.8125rem] text-muted-foreground">
            {t(
              quota.projection.cappedAtLimit
                ? 'admin.overview.projectedCapped'
                : 'admin.overview.projectedDetail',
              { value: formatGigabytes(quota.projection.projectedGB, locale, 0) },
            )}
          </dd>
        </Metric>
      </dl>
      <p className="text-sm text-muted-foreground">
        {t(`admin.overview.source.${quota.source}`)}{' '}
        {quota.quotaGB === null
          ? t('admin.overview.mode.unlimited')
          : t(`admin.overview.mode.${quota.mode}`)}
        {quota.quotaGB !== null && !quota.autoEconomy && ` ${t('admin.overview.noEconomy')}`}
      </p>
    </section>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 md:border-l md:px-6 md:first:border-l-0 md:first:pl-0">
      <dt className="eyebrow text-muted-foreground">{label}</dt>
      {children}
    </div>
  );
}

function Spaces({ spaces }: { spaces: SpaceUsage[] }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const toggle = useMutation({
    mutationFn: ({ id, suspend }: { id: string; suspend: boolean }) =>
      setSpaceSuspended(id, suspend),
  });
  return (
    <section className="flex flex-col gap-3" aria-labelledby="admin-spaces">
      <div className="flex flex-col gap-1">
        <h2 id="admin-spaces" className="text-lg font-semibold">
          {t('admin.overview.spaces.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('admin.overview.spaces.suspendHint')}</p>
      </div>
      {toggle.isError && (
        <Alert variant="destructive">
          <AlertDescription>{translateError(errorBodyOf(toggle.error), t)}</AlertDescription>
        </Alert>
      )}
      {spaces.length === 0 ? (
        <p className="text-[0.9375rem] text-muted-foreground">{t('admin.overview.spaces.empty')}</p>
      ) : (
        <DataList
          items={spaces}
          getKey={(space) => space.id}
          renderTable={(items) => (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-auto min-w-40 pl-4">
                    {t('admin.overview.spaces.name')}
                  </TableHead>
                  <TableHead className="hidden w-28 text-right sm:table-cell">
                    {t('admin.overview.spaces.members')}
                  </TableHead>
                  <TableHead className="w-32 text-right">
                    {t('admin.overview.spaces.usage')}
                  </TableHead>
                  <TableHead className="hidden w-32 md:table-cell">
                    {t('admin.overview.spaces.status')}
                  </TableHead>
                  <TableHead className="w-40 pr-4 text-right">
                    <span className="sr-only">{t('admin.overview.spaces.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((space) => {
                  const suspended = space.suspendedAt !== null;
                  return (
                    <TableRow key={space.id}>
                      <TableCell className="py-2 pl-4">
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate text-[0.9375rem]">{space.name}</span>
                          <span className="truncate font-mono text-[0.8125rem] text-muted-foreground">
                            {space.slug}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums sm:table-cell">
                        {space.members}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatGigabytes(space.estimatedGB, locale)}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <StatusBadge tone={suspended ? 'failed' : 'ok'}>
                          {suspended
                            ? t('admin.overview.spaces.suspended')
                            : t('admin.overview.spaces.active')}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <Button
                          variant={suspended ? 'outline' : 'destructive'}
                          size="sm"
                          disabled={toggle.isPending}
                          aria-label={t(
                            suspended
                              ? 'admin.overview.spaces.unsuspendLabel'
                              : 'admin.overview.spaces.suspendLabel',
                            { name: space.name },
                          )}
                          onClick={() => toggle.mutate({ id: space.id, suspend: !suspended })}
                        >
                          {suspended
                            ? t('admin.overview.spaces.unsuspend')
                            : t('admin.overview.spaces.suspend')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          renderCard={(space) => {
            const suspended = space.suspendedAt !== null;
            return (
              <DataCard
                title={space.name}
                badge={
                  <StatusBadge tone={suspended ? 'failed' : 'ok'}>
                    {suspended
                      ? t('admin.overview.spaces.suspended')
                      : t('admin.overview.spaces.active')}
                  </StatusBadge>
                }
                meta={[
                  <span key="slug" className="font-mono [overflow-wrap:anywhere]">
                    {space.slug}
                  </span>,
                  t('admin.overview.spaces.membersMeta', { count: space.members }),
                  formatGigabytes(space.estimatedGB, locale),
                ]}
                actions={
                  <DataCardActions
                    label={t('admin.overview.spaces.rowActions', { name: space.name })}
                  >
                    <DropdownMenuItem
                      variant={suspended ? 'default' : 'destructive'}
                      disabled={toggle.isPending}
                      onSelect={() => toggle.mutate({ id: space.id, suspend: !suspended })}
                    >
                      {suspended
                        ? t('admin.overview.spaces.unsuspend')
                        : t('admin.overview.spaces.suspend')}
                    </DropdownMenuItem>
                  </DataCardActions>
                }
              />
            );
          }}
        />
      )}
    </section>
  );
}

const NO_SPACE_SEARCH = { filter: 'no_space' } as const;

/**
 * Accounts in no space, room or pending request: before sign-up became invite-only anyone could
 * create one. They are reviewed on /admin/users, filtered.
 */
function UnattachedUsers() {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-3" aria-labelledby="admin-unattached">
      <div className="flex flex-col gap-1">
        <h2 id="admin-unattached" className="text-lg font-semibold">
          {t('admin.overview.unattached.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('admin.overview.unattached.hint')}</p>
      </div>
      <div>
        <Button asChild variant="outline">
          <Link to="/admin/users" search={NO_SPACE_SEARCH}>
            <UserListIcon data-icon="inline-start" />
            {t('admin.overview.unattached.review')}
          </Link>
        </Button>
      </div>
    </section>
  );
}
