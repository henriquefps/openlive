// SPDX-License-Identifier: AGPL-3.0-only
import { CaretRightIcon, PlusIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogForm,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from '@/components/ui/responsive-dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { meQuery } from '../api/auth.ts';
import { type Space, spacesQuery, useCreateSpace } from '../api/spaces.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { JoinCodeForm } from '../components/join/JoinCodeForm.tsx';
import { Page } from '../components/Page.tsx';
import { ErrorText, QueryError } from '../components/QueryError.tsx';
import { SLUG_PATTERN, slugify } from '../lib/slug.ts';
import { useTutorialScreen } from '../tutorial/context.ts';

export function SpacesPage() {
  const { t } = useTranslation();
  const spaces = useQuery(spacesQuery);
  const me = useQuery(meQuery);
  // Platform setting `spaceCreation`: on an admin-only instance, others see why there is no button.
  const canCreate = me.data?.canCreateSpace !== false;
  useTutorialScreen('spaces', spaces.isSuccess);
  return (
    <Page
      title={t('spaces.title')}
      description={t('spaces.intro')}
      actions={canCreate && spaces.data && spaces.data.length > 0 && <CreateSpaceDialog />}
    >
      {spaces.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : spaces.isError ? (
        <QueryError error={spaces.error} onRetry={() => void spaces.refetch()} />
      ) : spaces.data.length === 0 ? (
        <EmptyState
          data-tour="spaces-list"
          icon={UsersThreeIcon}
          title={t('spaces.empty.title')}
          description={canCreate ? t('spaces.empty.description') : t('spaces.create.restricted')}
        >
          {canCreate && <CreateSpaceDialog />}
        </EmptyState>
      ) : (
        <ul data-tour="spaces-list" className="flex flex-col divide-y rounded-xl border">
          {spaces.data.map((space) => (
            <li key={space.id}>
              <Link
                to="/s/$spaceSlug"
                params={{ spaceSlug: space.slug }}
                className="flex items-center gap-3 px-4 py-2 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 md:px-6"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[0.9375rem] font-medium">{space.name}</span>
                  <span className="truncate font-mono text-[0.8125rem] text-muted-foreground">
                    {`/s/${space.slug}`}
                  </span>
                </div>
                {space.role && <Badge variant="outline">{t(`roles.${space.role}`)}</Badge>}
                <CaretRightIcon className="text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <section className="flex max-w-lg flex-col gap-3" aria-labelledby="join-with-code">
        <h2 id="join-with-code" className="eyebrow text-muted-foreground">
          {t('join.title')}
        </h2>
        <JoinCodeForm id="spaces-join" />
      </section>
    </Page>
  );
}

/** Creates a space, then opens it; with `onCreated` (the onboarding wizard) it stays put. */
export function CreateSpaceDialog({ onCreated }: { onCreated?: (space: Space) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const create = useCreateSpace((space) => {
    setOpen(false);
    if (onCreated) return onCreated(space);
    return navigate({ to: '/s/$spaceSlug', params: { spaceSlug: space.slug } });
  });
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const effectiveSlug = slugEdited ? slug : slugify(name);
  const slugValid = SLUG_PATTERN.test(effectiveSlug);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ name: name.trim(), slug: effectiveSlug });
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setName('');
          setSlug('');
          setSlugEdited(false);
          create.reset();
        }
      }}
    >
      <ResponsiveDialogTrigger asChild>
        <Button data-tour="spaces-create">
          <PlusIcon data-icon="inline-start" />
          {t('spaces.create.action')}
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogForm onSubmit={submit} className="flex flex-col gap-6">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>{t('spaces.create.title')}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {t('spaces.create.description')}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="space-name">{t('spaces.create.name')}</FieldLabel>
                <Input
                  id="space-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  required
                  autoFocus
                />
              </Field>
              <Field data-invalid={effectiveSlug !== '' && !slugValid ? true : undefined}>
                <FieldLabel htmlFor="space-slug">{t('spaces.create.slug')}</FieldLabel>
                <Input
                  id="space-slug"
                  value={effectiveSlug}
                  onChange={(event) => {
                    setSlugEdited(true);
                    setSlug(event.target.value.toLowerCase());
                  }}
                  aria-invalid={effectiveSlug !== '' && !slugValid}
                  className="font-mono"
                  maxLength={48}
                  required
                />
                <FieldDescription>
                  {t('spaces.create.slugHint', { path: `/s/${effectiveSlug || '…'}` })}
                </FieldDescription>
              </Field>
            </FieldGroup>
            <ErrorText error={create.error} />
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button type="submit" disabled={!name.trim() || !slugValid || create.isPending}>
              {create.isPending && <Spinner data-icon="inline-start" />}
              {t('spaces.create.submit')}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogForm>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
