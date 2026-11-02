// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DataCard, DataList } from '../data-list.tsx';
import { errorBodyOf } from '../../api/client.ts';
import { adminStatusQuery, type StatusRange } from '../../api/status.ts';
import { translateError } from '../../i18n/errors.ts';
import {
  RangeToggle,
  StatusSummaryView,
  StatusUnavailableAlert,
  TTFF_TARGET_MS,
  useStatusFormat,
} from './StatusView.tsx';

/** The space page's status tab, where a row's name links to. */
const STATUS_TAB = { tab: 'status' } as const;

/** /admin: the status numbers of the whole instance and of each space. */
export function AdminStatus() {
  const { t, number, percent, ms } = useStatusFormat();
  const [range, setRange] = useState<StatusRange>('24h');
  const status = useQuery(adminStatusQuery(range));
  const data = status.data;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="admin-status">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="admin-status" className="text-lg font-semibold">
            {t('metrics.adminTitle')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('metrics.adminIntro')}</p>
        </div>
        <RangeToggle value={range} onChange={setRange} />
      </div>
      {status.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{translateError(errorBodyOf(status.error), t)}</AlertDescription>
        </Alert>
      ) : !data ? (
        <Skeleton className="h-40 w-full" />
      ) : !data.available ? (
        <StatusUnavailableAlert status={data} />
      ) : (
        <>
          <StatusSummaryView summary={data.summary} />
          {data.spaces.length > 0 && (
            <DataList
              items={data.spaces}
              getKey={(row) => row.spaceId}
              renderTable={(items) => (
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-auto min-w-40 pl-4">
                        {t('metrics.table.space')}
                      </TableHead>
                      <TableHead className="w-28 text-right">
                        {t('metrics.viewerMinutes')}
                      </TableHead>
                      <TableHead className="w-28 text-right">{t('metrics.ttff')}</TableHead>
                      <TableHead className="hidden w-28 text-right sm:table-cell">
                        {t('metrics.freezes')}
                      </TableHead>
                      <TableHead className="hidden w-28 text-right md:table-cell">
                        {t('metrics.drops')}
                      </TableHead>
                      <TableHead className="hidden w-48 pr-4 lg:table-cell">
                        {t('metrics.table.topError')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((row) => {
                      const s = row.summary;
                      const top = s?.topErrors[0];
                      return (
                        <TableRow key={row.spaceId}>
                          <TableCell className="truncate pl-4">
                            {row.slug && row.name ? (
                              <Link
                                to="/s/$spaceSlug"
                                params={{ spaceSlug: row.slug }}
                                search={STATUS_TAB}
                              >
                                {row.name}
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">
                                {t('metrics.table.deleted')}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {s ? number(s.viewerMinutes) : t('metrics.none')}
                          </TableCell>
                          <TableCell
                            className={
                              s?.ttff.medianMs != null && s.ttff.medianMs >= TTFF_TARGET_MS
                                ? 'text-right text-warning tabular-nums'
                                : 'text-right tabular-nums'
                            }
                          >
                            {ms(s?.ttff.medianMs ?? null)}
                          </TableCell>
                          <TableCell className="hidden text-right tabular-nums sm:table-cell">
                            {s?.freezesPerHour == null
                              ? t('metrics.none')
                              : number(s.freezesPerHour, 1)}
                          </TableCell>
                          <TableCell className="hidden text-right tabular-nums md:table-cell">
                            {s?.dropRate == null ? t('metrics.none') : percent(s.dropRate)}
                          </TableCell>
                          <TableCell className="hidden truncate pr-4 font-mono text-[0.8125rem] lg:table-cell">
                            {top ? `${top.code} (${number(top.count)})` : t('metrics.none')}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
              renderCard={(row) => {
                const s = row.summary;
                const named = row.slug && row.name;
                return (
                  <DataCard
                    title={
                      named ? (
                        row.name
                      ) : (
                        <span className="text-muted-foreground">{t('metrics.table.deleted')}</span>
                      )
                    }
                    wrap={
                      named
                        ? (content, className) => (
                            <Link
                              to="/s/$spaceSlug"
                              params={{ spaceSlug: row.slug as string }}
                              search={STATUS_TAB}
                              className={className}
                            >
                              {content}
                            </Link>
                          )
                        : undefined
                    }
                    meta={[
                      `${t('metrics.viewerMinutes')} ${s ? number(s.viewerMinutes) : t('metrics.none')}`,
                      `${t('metrics.ttff')} ${ms(s?.ttff.medianMs ?? null)}`,
                      `${t('metrics.freezes')} ${
                        s?.freezesPerHour == null ? t('metrics.none') : number(s.freezesPerHour, 1)
                      }`,
                    ]}
                  />
                );
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
