// SPDX-License-Identifier: AGPL-3.0-only
import { LightningIcon } from '@phosphor-icons/react';
import { getRouteApi } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { errorBodyOf } from '../api/client.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { JoinCodeForm } from '../components/join/JoinCodeForm.tsx';
import { useJoinByCode } from '../components/join/use-join-by-code.ts';
import { Page } from '../components/Page.tsx';
import { translateError } from '../i18n/errors.ts';

const route = getRouteApi('/join/$code');

/**
 * /join/:code, the shareable link of a quick room: joins at once and opens the room. When that
 * fails, says why and offers the form to fix the code.
 */
export function JoinPage() {
  const { t } = useTranslation();
  const { code } = route.useParams();
  const join = useJoinByCode();
  const { mutate } = join;
  // Once per code: every attempt counts against the rate limit, and StrictMode runs effects twice.
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (attempted.current === code) return;
    attempted.current = code;
    mutate(code);
  }, [code, mutate]);

  if (!join.isError) {
    return (
      <Page title={t('join.title')}>
        <div className="flex items-center gap-2 text-[0.9375rem] text-muted-foreground">
          <Spinner />
          {t('join.joining', { code })}
        </div>
      </Page>
    );
  }
  return (
    <Page title={t('join.title')}>
      <div className="flex w-full max-w-lg flex-col gap-6">
        <EmptyState
          icon={LightningIcon}
          title={t('join.failed')}
          description={translateError(errorBodyOf(join.error), t)}
        />
        <Card>
          <CardContent>
            <JoinCodeForm id="join-page" initialCode={code} />
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
