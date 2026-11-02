// SPDX-License-Identifier: AGPL-3.0-only
import { CheckCircleIcon, PlugsConnectedIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { approveDevice, deviceCodeQuery, normalizeUserCode } from '../api/devices.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { Page } from '../components/Page.tsx';
import { ErrorText } from '../components/QueryError.tsx';

const route = getRouteApi('/link');

/** The code format, the same in every language (apps/api/src/auth/devices.ts). */
const CODE_EXAMPLE = 'K7F-2QM';

/**
 * /link?code=K7F-2QM: pairs a helper with the signed-in account. The helper opens
 * this page with its code filled in; the person checks what is asking, names it and approves.
 */
export function LinkPage() {
  const { t } = useTranslation();
  const { code: fromUrl } = route.useSearch();
  const [typed, setTyped] = useState(fromUrl ?? '');
  const [code, setCode] = useState(() => normalizeUserCode(fromUrl ?? ''));

  return (
    <Page title={t('link.title')} description={t('link.intro')}>
      <div className="flex w-full max-w-lg flex-col gap-4">
        {code === null ? (
          <CodeForm typed={typed} setTyped={setTyped} onCode={setCode} />
        ) : (
          <Confirm
            code={code}
            onBack={() => {
              setTyped('');
              setCode(null);
            }}
          />
        )}
      </div>
    </Page>
  );
}

function CodeForm({
  typed,
  setTyped,
  onCode,
}: {
  typed: string;
  setTyped: (text: string) => void;
  onCode: (code: string) => void;
}) {
  const { t } = useTranslation();
  const valid = normalizeUserCode(typed);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) onCode(valid);
  };
  return (
    <Card>
      <CardContent>
        <form onSubmit={submit}>
          <Field>
            <FieldLabel htmlFor="link-code">{t('link.codeLabel')}</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="link-code"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder={CODE_EXAMPLE}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                maxLength={16}
                required
                autoFocus
              />
              <Button type="submit" disabled={!valid}>
                {t('link.next')}
              </Button>
            </div>
            <FieldDescription>{t('link.codeHint')}</FieldDescription>
          </Field>
        </form>
      </CardContent>
    </Card>
  );
}

function Confirm({ code, onBack }: { code: string; onBack: () => void }) {
  const { t } = useTranslation();
  const info = useQuery(deviceCodeQuery(code));
  const [name, setName] = useState<string | null>(null);
  const approve = useMutation({ mutationFn: approveDevice });

  if (approve.isSuccess) {
    return (
      <EmptyState
        icon={CheckCircleIcon}
        title={t('link.pairedTitle')}
        description={t('link.pairedDescription')}
      >
        <Button asChild variant="outline">
          <Link to="/settings">{t('link.toDevices')}</Link>
        </Button>
      </EmptyState>
    );
  }
  if (info.isPending) {
    return (
      <div className="flex items-center gap-2 text-[0.9375rem] text-muted-foreground">
        <Spinner />
        {t('link.checking', { code })}
      </div>
    );
  }
  if (info.isError) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3">
          <ErrorText error={info.error} />
          <div>
            <Button variant="outline" onClick={onBack}>
              {t('link.tryAnother')}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const os = t(`download.os.${info.data.os}`);
  const deviceName = name ?? info.data.name ?? t('link.defaultName', { os });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    approve.mutate({ userCode: code, name: deviceName.trim() });
  };
  return (
    <Card>
      <form onSubmit={submit}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PlugsConnectedIcon className="size-5" aria-hidden />
            {t('link.confirmTitle')}
          </CardTitle>
          <CardDescription>
            {t('link.confirmDescription', {
              os,
              arch: info.data.arch,
              version: info.data.helperVersion,
              code,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="py-4">
          <Field>
            <FieldLabel htmlFor="link-name">{t('link.nameLabel')}</FieldLabel>
            <Input
              id="link-name"
              value={deviceName}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
            />
            <FieldDescription>{t('link.nameHint')}</FieldDescription>
          </Field>
          <ErrorText error={approve.error} />
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button type="submit" disabled={!deviceName.trim() || approve.isPending}>
            {approve.isPending && <Spinner data-icon="inline-start" />}
            {t('link.approve')}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack}>
            {t('common.cancel')}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
