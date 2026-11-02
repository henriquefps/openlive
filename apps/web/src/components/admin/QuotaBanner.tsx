// SPDX-License-Identifier: AGPL-3.0-only
import { WarningIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { meQuery } from '../../api/auth.ts';
import { formatGigabytes, formatUsd } from './format.ts';

/**
 * The mandatory in-app quota warning: shown to every
 * signed-in user above 70 % of the admin's monthly limit, and once usage passes the free tier,
 * whatever the limit (unlimited included). /api/me carries the codes and the limit; only the
 * platform admin gets the cost so far.
 */
export function QuotaBanner() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const me = useQuery(meQuery);
  const quota = me.data?.quota;
  if (!quota) return null;
  const warn = quota.level !== 'ok';
  if (!warn && !quota.freeTierExceeded) return null;
  const full = quota.level === 'warn_100';
  const limit = quota.limitGB === null ? '' : formatGigabytes(quota.limitGB, locale, 0);
  const lines = [
    quota.economyMode && t('admin.banner.economy'),
    quota.blockNewStreams
      ? t('admin.banner.blocked')
      : full
        ? t('admin.banner.overLimit')
        : warn && !quota.economyMode
          ? t(quota.mode === 'block' ? 'admin.banner.nearingBlock' : 'admin.banner.nearingAlerts')
          : null,
    quota.freeTierExceeded &&
      (quota.costUsd === undefined
        ? t('admin.banner.freeTier')
        : t('admin.banner.freeTierCost', { usd: formatUsd(quota.costUsd, locale) })),
  ].filter((line): line is string => Boolean(line));
  const destructive = full || quota.blockNewStreams;
  return (
    <div className="border-b px-4 py-3 md:px-6">
      <Alert
        variant={destructive ? 'destructive' : 'default'}
        className={destructive ? undefined : 'border-warning/50 *:[svg]:text-warning'}
      >
        <WarningIcon />
        <AlertTitle>
          {quota.level !== 'ok'
            ? t(`admin.banner.title.${quota.level}`, { limit })
            : t('admin.banner.title.freeTier')}
        </AlertTitle>
        <AlertDescription>
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </AlertDescription>
        {me.data?.user.isPlatformAdmin && (
          <AlertAction>
            <Button asChild variant="outline" size="sm">
              <Link to="/admin">{t('admin.banner.details')}</Link>
            </Button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
}
