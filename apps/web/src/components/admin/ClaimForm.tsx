// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { claimAdmin } from '../../api/admin.ts';
import { errorBodyOf } from '../../api/client.ts';
import { translateError } from '../../i18n/errors.ts';

/** The install-code form: the first person with the code becomes the admin. */
export function ClaimForm({ onClaimed }: { onClaimed: () => void }) {
  const { t } = useTranslation();
  const inputId = useId();
  const errorId = useId();
  const [code, setCode] = useState('');
  const claim = useMutation({ mutationFn: claimAdmin, onSuccess: onClaimed });
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        claim.mutate(code.trim());
      }}
    >
      <Field data-invalid={claim.isError || undefined}>
        <FieldLabel htmlFor={inputId}>{t('admin.claim.code')}</FieldLabel>
        <FieldDescription>{t('admin.claim.description')}</FieldDescription>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={inputId}
            required
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-invalid={claim.isError || undefined}
            aria-describedby={claim.isError ? errorId : undefined}
            className="font-mono sm:max-w-80"
          />
          <Button type="submit" disabled={claim.isPending || code.trim() === ''}>
            {claim.isPending ? t('admin.claim.submitting') : t('admin.claim.submit')}
          </Button>
        </div>
        {claim.isError && (
          <FieldError id={errorId}>{translateError(errorBodyOf(claim.error), t)}</FieldError>
        )}
      </Field>
    </form>
  );
}
