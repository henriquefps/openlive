// SPDX-License-Identifier: AGPL-3.0-only
import { DeviceMobileIcon, DevicesIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { revokeSession, type Session, sessionsQuery } from '../api/auth.ts';
import { errorBodyOf } from '../api/client.ts';
import { translateError } from '../i18n/errors.ts';
import { formatDate } from '../i18n/format.ts';
import { describeUserAgent } from '../lib/user-agent.ts';

/**
 * Settings > Sessions: the browsers and mobile apps signed in to this account, each with a revoke
 * button. Revoking an app also closes its connections at once.
 */
export function SessionsCard() {
  const { t } = useTranslation();
  const sessions = useQuery(sessionsQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.sessions.title')}</CardTitle>
        <CardDescription>{t('settings.sessions.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {sessions.isPending ? (
          <Skeleton className="h-14 w-full" />
        ) : sessions.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {translateError(errorBodyOf(sessions.error), t)}
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {sessions.data.sessions.map((session) => (
              <SessionRow key={session.id} session={session} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SessionRow({ session }: { session: Session }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeSession(session.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionsQuery.queryKey }),
  });
  const name = sessionName(session, t);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const date = (at: number) =>
    formatDate(at, locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  const Icon = session.kind === 'app' ? DeviceMobileIcon : DevicesIcon;
  return (
    <li className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-[0.9375rem]">
          <span className="truncate">{name}</span>
          {session.current && (
            <Badge variant="outline">
              {t(
                session.kind === 'app'
                  ? 'settings.sessions.currentApp'
                  : 'settings.sessions.current',
              )}
            </Badge>
          )}
        </span>
        <span className="text-[0.8125rem] text-muted-foreground">
          {session.kind === 'app' && session.lastUsedAt !== null
            ? t('settings.sessions.lastUsedAt', { date: date(session.lastUsedAt) })
            : t('settings.sessions.signedInAt', { date: date(session.createdAt) })}
        </span>
        {revoke.isError && (
          <span className="text-[0.8125rem] text-destructive" role="alert">
            {translateError(errorBodyOf(revoke.error), t)}
          </span>
        )}
      </div>
      {!session.current && (
        <Button
          variant="outline"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate()}
          aria-label={t('settings.sessions.revokeLabel', { name })}
        >
          {t('settings.sessions.revoke')}
        </Button>
      )}
    </li>
  );
}

/** "Chrome on Linux", or "Openlive app · Ana's iPhone" for the mobile app. */
function sessionName(session: Session, t: TFunction): string {
  if (session.kind === 'app') return t('settings.sessions.app', { device: session.deviceName });
  const { browser, os } = describeUserAgent(session.userAgent);
  return browser && os
    ? t('settings.sessions.device', { browser, os })
    : (browser ?? os ?? t('settings.sessions.unknownDevice'));
}
