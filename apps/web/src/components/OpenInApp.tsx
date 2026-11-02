// SPDX-License-Identifier: AGPL-3.0-only
import { DeviceMobileIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { APP_STORE_LINKS, appJoinLink, isPhone } from '../api/app.ts';

/**
 * "Open in app" for an invite, on phones only: openlive://join hands the
 * app this instance and the invite together. The web flow stays next to it, for anyone without
 * the app. The store links show once the app is published.
 */
export function OpenInApp({ inviteToken }: { inviteToken: string }) {
  const { t } = useTranslation();
  if (!isPhone()) return null;
  const stores = (['ios', 'android'] as const).flatMap((store) => {
    const url = APP_STORE_LINKS[store];
    return url ? [{ store, url }] : [];
  });
  return (
    <Alert className="w-full max-w-lg">
      <DeviceMobileIcon />
      <AlertTitle>{t('openInApp.title')}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>{t('openInApp.description')}</span>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm">
            <a href={appJoinLink(window.location.origin, inviteToken)}>{t('openInApp.open')}</a>
          </Button>
          {stores.map(({ store, url }) => (
            <Button key={store} asChild size="sm" variant="outline">
              <a href={url} target="_blank" rel="noreferrer">
                {t(`openInApp.get.${store}`)}
              </a>
            </Button>
          ))}
        </div>
      </AlertDescription>
    </Alert>
  );
}
