// SPDX-License-Identifier: AGPL-3.0-only
import { CompassIcon } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { EmptyState } from '../components/EmptyState.tsx';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col p-4 md:p-6">
      <EmptyState
        heading="h1"
        icon={CompassIcon}
        title={t('notFound.title')}
        description={t('notFound.intro')}
      >
        <Button asChild variant="outline">
          <Link to="/">{t('notFound.back')}</Link>
        </Button>
      </EmptyState>
    </div>
  );
}
