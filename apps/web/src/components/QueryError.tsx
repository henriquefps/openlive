// SPDX-License-Identifier: AGPL-3.0-only
import { WarningCircleIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorBodyOf } from '../api/client.ts';
import { translateError } from '../i18n/errors.ts';

/** A failed load: the translated error code and a retry button. */
export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert variant="destructive">
      <WarningCircleIcon />
      <AlertTitle>{t('common.loadFailed')}</AlertTitle>
      <AlertDescription>{translateError(errorBodyOf(error), t)}</AlertDescription>
      {onRetry && (
        <AlertAction>
          <Button variant="outline" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}

/** A mutation's error under a form or row, announced to screen readers. */
export function ErrorText({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <p className="text-[0.8125rem] text-destructive" role="alert">
      {translateError(errorBodyOf(error), t)}
    </p>
  );
}
