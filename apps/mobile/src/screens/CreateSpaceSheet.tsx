// SPDX-License-Identifier: AGPL-3.0-only
import type { Space } from '@openlive/client';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCreateSpace } from '../account-queries.ts';
import { Button, Field } from '../components/ui.tsx';
import { Sheet } from '../components/ui/index.ts';
import { checkNewSpace } from '../lib/space-create.ts';
import { ErrorLine, Hint } from './space/shared.tsx';

/** The web's CreateSpaceDialog: a name and an address that follows it until edited. */
export function CreateSpaceSheet({
  origin,
  open,
  onClose,
  onCreated,
}: {
  origin: string;
  open: boolean;
  onClose: () => void;
  onCreated: (space: Space) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateSpace(origin);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const check = checkNewSpace(name, slug);

  const close = () => {
    onClose();
    setName('');
    setSlug(null);
    create.reset();
  };
  const submit = () =>
    create.mutate(
      { name: name.trim(), slug: check.slug },
      {
        onSuccess: (space) => {
          close();
          onCreated(space);
        },
      },
    );

  return (
    <Sheet
      open={open}
      onClose={close}
      title={t('spaces.create.title')}
      description={t('spaces.create.description')}
    >
      <Field
        label={t('spaces.create.name')}
        value={name}
        onChangeText={setName}
        maxLength={80}
        autoFocus
      />
      <Field
        label={t('spaces.create.slug')}
        value={check.slug}
        onChangeText={(v) => setSlug(v.toLowerCase())}
        maxLength={48}
        autoCapitalize="none"
        autoCorrect={false}
        invalid={check.slug !== '' && !check.slugValid}
      />
      <Hint>{t('spaces.create.slugHint', { path: `/s/${check.slug || '…'}` })}</Hint>
      <ErrorLine error={create.error} />
      <Button
        label={t('spaces.create.submit')}
        disabled={!check.valid}
        busy={create.isPending}
        onPress={submit}
      />
    </Sheet>
  );
}
