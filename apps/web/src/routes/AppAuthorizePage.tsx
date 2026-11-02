// SPDX-License-Identifier: AGPL-3.0-only
import { DeviceMobileIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { authorizeApp, deniedRedirect, openInApp, parseAuthorizeRequest } from '../api/app.ts';
import { meQuery } from '../api/auth.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { Page } from '../components/Page.tsx';
import { ErrorText } from '../components/QueryError.tsx';

/**
 * /app/authorize: the mobile app's login. The app opened this page in the system
 * browser; the signed-in person allows or refuses it, and the page sends the browser back to
 * openlive://auth with a one-time code or access_denied. A request that is not exactly what the
 * app sends is refused here, without any redirect.
 */
export function AppAuthorizePage() {
  const { t } = useTranslation();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const request = useMemo(() => parseAuthorizeRequest(new URLSearchParams(searchStr)), [searchStr]);
  const me = useQuery(meQuery);
  const [denied, setDenied] = useState(false);
  const allow = useMutation({
    mutationFn: authorizeApp,
    onSuccess: (redirectTo) => openInApp(redirectTo),
  });
  const instance = window.location.host;

  if (!request) {
    return (
      <Page title={t('appAuthorize.title')}>
        <EmptyState
          icon={WarningCircleIcon}
          title={t('appAuthorize.invalid.title')}
          description={t('appAuthorize.invalid.description')}
        />
      </Page>
    );
  }
  if (allow.isSuccess || denied) {
    return (
      <Page title={t('appAuthorize.title')}>
        <EmptyState
          icon={DeviceMobileIcon}
          title={t(denied ? 'appAuthorize.denied' : 'appAuthorize.allowed')}
          description={t('appAuthorize.backToApp')}
        />
      </Page>
    );
  }
  return (
    <Page title={t('appAuthorize.title')}>
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DeviceMobileIcon className="size-5" aria-hidden />
            {t('appAuthorize.question', { device: request.deviceName, instance })}
          </CardTitle>
          <CardDescription>
            {t('appAuthorize.description', { name: me.data?.user.displayName ?? '' })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-[0.9375rem]">
          <p className="text-muted-foreground">{t('appAuthorize.warning')}</p>
          <ErrorText error={allow.error} />
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button disabled={allow.isPending} onClick={() => allow.mutate(request)}>
            {allow.isPending && <Spinner data-icon="inline-start" />}
            {t('appAuthorize.allow')}
          </Button>
          <Button
            variant="outline"
            disabled={allow.isPending}
            onClick={() => {
              setDenied(true);
              openInApp(deniedRedirect(request.state));
            }}
          >
            {t('appAuthorize.deny')}
          </Button>
        </CardFooter>
      </Card>
    </Page>
  );
}
