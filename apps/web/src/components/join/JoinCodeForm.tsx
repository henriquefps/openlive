// SPDX-License-Identifier: AGPL-3.0-only
import { SignInIcon } from '@phosphor-icons/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ErrorText } from '../QueryError.tsx';
import { useJoinByCode } from './use-join-by-code.ts';

/** The code format, the same in every language (apps/api/src/api/rooms.ts). */
const CODE_EXAMPLE = 'OL-1234-5678';

/** "Join with code": a quick room's code (OL-4821-0937), typed in any form the API accepts. */
export function JoinCodeForm({
  id,
  initialCode = '',
  autoFocus = false,
  onJoined,
}: {
  /** Prefix for the input id, so the form can appear twice on a page. */
  id: string;
  initialCode?: string;
  autoFocus?: boolean;
  /** After the room opened (a dialog closes itself here). */
  onJoined?: () => void;
}) {
  const { t } = useTranslation();
  const join = useJoinByCode();
  const [code, setCode] = useState(initialCode);
  const inputId = `${id}-code`;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    join.mutate(code.trim(), { onSuccess: () => onJoined?.() });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Field data-invalid={join.isError ? true : undefined}>
        <FieldLabel htmlFor={inputId}>{t('join.label')}</FieldLabel>
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              if (join.isError) join.reset();
            }}
            placeholder={CODE_EXAMPLE}
            aria-invalid={join.isError}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            maxLength={64}
            required
            autoFocus={autoFocus}
          />
          <Button type="submit" disabled={!code.trim() || join.isPending}>
            {join.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <SignInIcon data-icon="inline-start" />
            )}
            {t('join.submit')}
          </Button>
        </div>
        <FieldDescription>{t('join.hint')}</FieldDescription>
      </Field>
      <ErrorText error={join.error} />
    </form>
  );
}
