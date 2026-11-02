// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/skeleton';
import type { Space } from '../../api/spaces.ts';
import { spaceStatusQuery, type StatusRange } from '../../api/status.ts';
import { QueryError } from '../../components/QueryError.tsx';
import {
  RangeToggle,
  StatusSummaryView,
  StatusUnavailableAlert,
} from '../../components/status/StatusView.tsx';

/** The space status page, for the space's owners and admins. */
export function StatusTab({ space }: { space: Space }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<StatusRange>('24h');
  const status = useQuery(spaceStatusQuery(space.id, range));
  return (
    <section className="flex flex-col gap-4" aria-labelledby="space-status">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="space-status" className="text-lg font-semibold">
            {t('metrics.spaceTitle')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('metrics.spaceIntro')}</p>
        </div>
        <RangeToggle value={range} onChange={setRange} />
      </div>
      {status.isError ? (
        <QueryError error={status.error} onRetry={() => void status.refetch()} />
      ) : !status.data ? (
        <Skeleton className="h-40 w-full" />
      ) : status.data.available ? (
        <StatusSummaryView summary={status.data.summary} />
      ) : (
        <StatusUnavailableAlert status={status.data} />
      )}
    </section>
  );
}
