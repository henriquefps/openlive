// SPDX-License-Identifier: AGPL-3.0-only
import { EnvelopeSimpleIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { type SignupContext, signupPolicyQuery, startEmailLogin } from '../api/auth.ts';
import { errorBodyOf } from '../api/client.ts';
import { translateError } from '../i18n/errors.ts';

/**
 * "Check your inbox": shown once the API accepted the request (same for every address). On an
 * invite-only instance without an invite, `inviteOnly` adds why a new address may get nothing.
 */
function CheckInbox({
  email,
  onBack,
  inviteOnly = false,
}: {
  email?: string;
  onBack?: () => void;
  inviteOnly?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Alert role="status">
      <EnvelopeSimpleIcon />
      <AlertTitle>{t('auth.email.sentTitle')}</AlertTitle>
      <AlertDescription>
        <p>{email ? t('auth.email.sentTo', { email }) : t('auth.email.sent')}</p>
        {inviteOnly && <p>{t('auth.email.inviteOnly')}</p>}
        {onBack && (
          <Button variant="link" className="h-auto p-0" onClick={onBack}>
            {t('auth.email.another')}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * The magic-link form: an address in, "check your inbox" out. `context` is the invite
 * or room code the login started from, which an invite-only instance needs for a new account.
 */
export function EmailSignIn({
  returnTo,
  context = {},
}: {
  returnTo?: string | undefined;
  context?: SignupContext;
}) {
  const { t, i18n } = useTranslation();
  const inputId = useId();
  const errorId = useId();
  const [email, setEmail] = useState('');
  const send = useMutation({
    mutationFn: (address: string) =>
      startEmailLogin({
        email: address,
        locale: i18n.resolvedLanguage ?? i18n.language,
        ...(returnTo ? { returnTo } : {}),
        ...context,
      }),
  });

  const policy = useQuery(signupPolicyQuery);
  const inviteOnly = policy.data?.signup === 'invite_only' && !context.invite && !context.code;

  if (send.isSuccess) {
    return (
      <CheckInbox email={send.variables} onBack={() => send.reset()} inviteOnly={inviteOnly} />
    );
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        send.mutate(email.trim());
      }}
    >
      <Field data-invalid={send.isError || undefined}>
        <FieldLabel htmlFor={inputId}>{t('auth.email.label')}</FieldLabel>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={inputId}
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={send.isError || undefined}
            aria-describedby={send.isError ? errorId : undefined}
            className="sm:max-w-80"
          />
          <Button type="submit" variant="outline" disabled={send.isPending}>
            {send.isPending ? t('auth.email.sending') : t('auth.email.submit')}
          </Button>
        </div>
        {send.isError && (
          <FieldError id={errorId}>{translateError(errorBodyOf(send.error), t)}</FieldError>
        )}
      </Field>
    </form>
  );
}

/**
 * The Discord account's verified e-mail already has an account: accounts are never joined
 * silently, so the person confirms with a magic link to that address.
 */
export function LinkOffer() {
  const { t, i18n } = useTranslation();
  const send = useMutation({
    mutationFn: () =>
      startEmailLogin({ link: true, locale: i18n.resolvedLanguage ?? i18n.language }),
  });
  if (send.isSuccess) return <CheckInbox />;
  return (
    <Alert>
      <EnvelopeSimpleIcon />
      <AlertTitle>{t('auth.link.title')}</AlertTitle>
      <AlertDescription>
        <p>{t('auth.link.description')}</p>
        {send.isError && (
          <p className="text-destructive" role="alert">
            {translateError(errorBodyOf(send.error), t)}
          </p>
        )}
        <Button
          className="mt-2"
          variant="outline"
          disabled={send.isPending}
          onClick={() => send.mutate()}
        >
          {send.isPending ? t('auth.email.sending') : t('auth.link.send')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
