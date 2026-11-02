// SPDX-License-Identifier: AGPL-3.0-only
import { SignInIcon } from '@phosphor-icons/react';
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Page } from '../components/Page.tsx';

/**
 * /login/verify?token=: where the magic link lands. Opening it uses nothing, so a mail
 * scanner that follows links cannot burn it; the button posts the token as a plain top-level form,
 * and the API answers with the session cookie and a redirect.
 *
 * The token does not stay in the address bar: once read, the entry is replaced by a bare
 * /login/verify that carries the token in its history state (security
 * review, L6). The address bar, the tab's back/forward entry and a later copy of the URL no longer show
 * it, and a reload of the tab still finds it. The browser may still have recorded the visited
 * link in its global history; that is why the token is single use and lives 15 minutes.
 */
const VERIFY_FORM = { method: 'post', action: '/api/auth/email/verify' } as const;
const TOKEN_FIELD = { type: 'hidden', name: 'token' } as const;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function LoginVerifyPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token: fromUrl } = useSearch({ strict: false });
  const fromState = useLocation({
    select: (location) => (location.state as { verifyToken?: unknown }).verifyToken,
  });
  const token = fromUrl ?? fromState;
  useEffect(() => {
    if (fromUrl === undefined) return;
    void navigate({
      to: '/login/verify',
      search: {},
      state: (prev) => ({ ...prev, verifyToken: fromUrl }),
      replace: true,
    });
  }, [fromUrl, navigate]);
  const valid = typeof token === 'string' && TOKEN_PATTERN.test(token);
  return (
    <Page title={t('auth.verify.title')}>
      <div className="flex max-w-md flex-col gap-4">
        {valid ? (
          <Card>
            <CardHeader>
              <CardTitle>{t('app.name')}</CardTitle>
              <CardDescription>{t('auth.verify.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <form {...VERIFY_FORM}>
                <input {...TOKEN_FIELD} value={token} />
                <Button type="submit" className="w-full">
                  <SignInIcon data-icon="inline-start" />
                  {t('auth.verify.submit')}
                </Button>
              </form>
            </CardContent>
          </Card>
        ) : (
          <Alert variant="destructive">
            <AlertDescription>{t('auth.verify.missing')}</AlertDescription>
          </Alert>
        )}
      </div>
    </Page>
  );
}
