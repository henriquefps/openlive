// SPDX-License-Identifier: AGPL-3.0-only
import {
  ArrowRightIcon,
  BrowserIcon,
  DesktopTowerIcon,
  DiscordLogoIcon,
  EnvelopeOpenIcon,
  EnvelopeSimpleIcon,
  LockKeyIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  discordStartUrl,
  meQuery,
  type SignupContext,
  signupContextOf,
  signupPolicyQuery,
} from '../api/auth.ts';
import { errorBodyOf } from '../api/client.ts';
import { healthQuery } from '../api/health.ts';
import { EmailSignIn, LinkOffer } from '../components/EmailSignIn.tsx';
import { OpenInApp } from '../components/OpenInApp.tsx';
import { Page } from '../components/Page.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { translateError } from '../i18n/errors.ts';

const FEATURES = [
  { key: 'rooms', icon: LockKeyIcon },
  { key: 'helper', icon: DesktopTowerIcon },
  { key: 'watch', icon: BrowserIcon },
] as const;

/** A same-app path to come back to after login; the API checks it again. */
function safeReturnTo(value: string | undefined): string | undefined {
  return value?.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : undefined;
}

export function HomePage() {
  const { t } = useTranslation();
  const featuresId = useId();
  const search = useSearch({ strict: false });
  const me = useQuery(meQuery);
  const returnTo = safeReturnTo(search.returnTo);
  return (
    <Page title={t('home.title')} description={t('home.intro')} actions={<ServerStatus />}>
      <section className="flex max-w-2xl flex-col gap-4">
        <p className="text-base">{t('home.description')}</p>
        {search.authError && (
          <Alert variant="destructive">
            <AlertDescription>{translateError({ code: search.authError }, t)}</AlertDescription>
          </Alert>
        )}
        {me.data ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <p className="text-[0.9375rem]">
              {t('home.signedIn', { name: me.data.user.displayName })}
            </p>
            <Button asChild className="w-full sm:ml-auto sm:w-auto">
              <Link to="/spaces">
                {t('home.openSpaces')}
                <ArrowRightIcon data-icon="inline-end" />
              </Link>
            </Button>
          </div>
        ) : search.auth === 'link_offer' ? (
          <LinkOffer />
        ) : (
          <SignIn returnTo={returnTo} />
        )}
      </section>
      <section className="flex flex-col gap-3" aria-labelledby={featuresId}>
        <h2 id={featuresId} className="eyebrow">
          {t('home.features.label')}
        </h2>
        <ul className="grid gap-4 md:grid-cols-3">
          {FEATURES.map(({ key, icon: Icon }) => (
            <li key={key} className="flex flex-col *:flex-1">
              <Card size="sm">
                <CardHeader>
                  <Icon className="mb-2 size-5 text-primary" aria-hidden />
                  <CardTitle>{t(`home.features.${key}.title`)}</CardTitle>
                  <CardDescription>{t(`home.features.${key}.description`)}</CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}

/**
 * The two login methods. Arriving from an invite or a quick room link (the route guard put it in
 * `returnTo`), the login carries that invite or code, which is what lets a new account be created
 * on an invite-only instance.
 */
function SignIn({ returnTo }: { returnTo: string | undefined }) {
  const { t } = useTranslation();
  const context: SignupContext = signupContextOf(returnTo);
  const hasContext = context.invite !== undefined || context.code !== undefined;
  const policy = useQuery(signupPolicyQuery);
  const inviteOnly = policy.data?.signup === 'invite_only';
  return (
    <div className="flex flex-col gap-4">
      {/* An invite opened on a phone: the app can sign in and join by itself. */}
      {context.invite && !returnTo?.startsWith('/app/authorize') && (
        <OpenInApp inviteToken={context.invite} />
      )}
      {hasContext && (
        <Alert>
          <EnvelopeOpenIcon />
          <AlertDescription>
            {context.invite ? t('home.signIn.withInvite') : t('home.signIn.withCode')}
          </AlertDescription>
        </Alert>
      )}
      <div>
        {/* A plain link: the API answers with redirects (to Discord, then back here). */}
        <Button asChild className="w-full sm:w-auto">
          <a href={discordStartUrl(returnTo, context)}>
            <DiscordLogoIcon data-icon="inline-start" />
            {t('home.signIn.discord')}
          </a>
        </Button>
      </div>
      <div className="flex items-center gap-3 text-[0.8125rem] text-muted-foreground">
        <span className="h-px flex-1 bg-border" aria-hidden />
        <EnvelopeSimpleIcon aria-hidden />
        {t('home.signIn.or')}
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>
      <EmailSignIn returnTo={returnTo} context={context} />
      <p className="text-[0.8125rem] text-muted-foreground">
        {inviteOnly && !hasContext ? t('home.signIn.inviteOnly') : t('home.signIn.note')}
      </p>
    </div>
  );
}

function ServerStatus() {
  const { t } = useTranslation();
  const health = useQuery(healthQuery);
  if (health.isPending) {
    return (
      <StatusBadge tone="idle" role="status">
        {t('home.health.loading')}
      </StatusBadge>
    );
  }
  if (health.isError) {
    return (
      <StatusBadge tone="failed" role="alert">
        {translateError(errorBodyOf(health.error), t)}
      </StatusBadge>
    );
  }
  return (
    <StatusBadge tone="ok" role="status">
      {t('home.health.ok', { version: health.data.version, commit: health.data.commit })}
    </StatusBadge>
  );
}
