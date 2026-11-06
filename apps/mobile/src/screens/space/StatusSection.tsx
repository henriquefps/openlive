// SPDX-License-Identifier: AGPL-3.0-only
import {
  STATUS_RANGES,
  type StatusRange,
  type StatusSummary,
  type StatusUnavailable,
} from '@openlive/client';
import { ChartLine, Key, Warning } from 'phosphor-react-native';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { Card, Heading, Segmented } from '../../components/ui.tsx';
import { Skeleton } from '../../components/ui/Skeleton.tsx';
import { isEmptySummary, isSlowStart } from '../../lib/status-view.ts';
import { useSpaceStatus } from '../../space-queries.ts';
import { font, useTheme } from '../../theme.ts';
import { Hint, QueryFailure, type SectionProps } from './shared.tsx';

/** The space status (owners and admins): the same read-only numbers as the web's StatusTab. */
export function StatusSection({ origin, space }: SectionProps) {
  const { t } = useTranslation();
  const [range, setRange] = useState<StatusRange>('24h');
  const status = useSpaceStatus(origin, space.id, range);
  return (
    <>
      <View style={styles.gap}>
        <Heading>{t('metrics.spaceTitle')}</Heading>
        <Hint>{t('metrics.spaceIntro')}</Hint>
      </View>
      <Segmented
        options={STATUS_RANGES.map((r) => ({ value: r, label: t(`metrics.range.${r}`) }))}
        value={range}
        onChange={setRange}
      />
      {status.isError && status.data === undefined ? (
        <QueryFailure error={status.error} onRetry={() => void status.refetch()} />
      ) : !status.data ? (
        <Skeleton height={160} />
      ) : status.data.available ? (
        <SummaryView summary={status.data.summary} />
      ) : (
        <UnavailableCard status={status.data} />
      )}
    </>
  );
}

function UnavailableCard({ status }: { status: StatusUnavailable }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [icon, title, hint] =
    status.reason === 'not_configured'
      ? ([
          <ChartLine key="i" size={20} color={colors.foreground} />,
          t('metrics.unavailable.notConfigured'),
          t('metrics.unavailable.notConfiguredHint', { missing: status.missing.join(', ') }),
        ] as const)
      : status.reason === 'permission'
        ? ([
            <Key key="i" size={20} color={colors.foreground} />,
            t('metrics.unavailable.permission'),
            t('metrics.unavailable.permissionHint', { permission: status.permission }),
          ] as const)
        : ([
            <Warning key="i" size={20} color={colors.destructive} />,
            t('metrics.unavailable.failed'),
            t('metrics.unavailable.failedHint'),
          ] as const);
  return (
    <Card>
      {icon}
      <Text style={[styles.value, { color: colors.foreground, fontSize: 16 }]}>{title}</Text>
      <Hint>{hint}</Hint>
    </Card>
  );
}

function Metric({
  label,
  value,
  bad = false,
  notes = [],
}: {
  label: string;
  value: string;
  bad?: boolean;
  notes?: string[];
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.metric}>
      <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.value, { color: bad ? colors.warning : colors.foreground }]}>
        {value}
      </Text>
      {notes.map((note) => (
        <Text key={note} style={[styles.note, { color: colors.mutedForeground }]}>
          {note}
        </Text>
      ))}
    </View>
  );
}

function Pair({ label, value }: { label: string; value: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.pair}>
      <Text style={[styles.pairLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.pairValue, { color: colors.foreground }]}>{value}</Text>
    </View>
  );
}

/** One range's numbers (the web's StatusSummaryView). */
function SummaryView({ summary }: { summary: StatusSummary }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const number = (n: number, digits = 0) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);
  const percent = (fraction: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(fraction);
  const none = t('metrics.none');
  const ms = (value: number | null) =>
    value === null ? none : t('metrics.ms', { value: number(value) });
  const { ttff, helper } = summary;
  return (
    <View style={styles.summary}>
      {isEmptySummary(summary) ? <Hint>{t('metrics.empty')}</Hint> : null}
      <View style={styles.grid}>
        <Metric
          label={t('metrics.ttff')}
          value={ms(ttff.medianMs)}
          bad={isSlowStart(ttff.medianMs)}
          notes={[
            t('metrics.ttffDetail', { p90: ms(ttff.p90Ms), count: ttff.count }),
            ...(ttff.prepull.count > 0
              ? [
                  t('metrics.ttffByStart', {
                    prepull: ms(ttff.prepull.medianMs),
                    click: ms(ttff.click.medianMs),
                  }),
                ]
              : []),
          ]}
        />
        <Metric
          label={t('metrics.freezes')}
          value={summary.freezesPerHour === null ? none : number(summary.freezesPerHour, 1)}
          notes={[t('metrics.reconnects', { count: summary.reconnects })]}
        />
        <Metric label={t('metrics.viewerMinutes')} value={number(summary.viewerMinutes)} />
        <Metric
          label={t('metrics.drops')}
          value={summary.dropRate === null ? none : percent(summary.dropRate)}
          bad={summary.streamsDropped > 0}
          notes={[
            t('metrics.dropsDetail', {
              dropped: summary.streamsDropped,
              count: summary.streamsEnded,
            }),
          ]}
        />
      </View>
      <Card>
        <Heading>{t('metrics.helper.title')}</Heading>
        {helper.minutes === 0 ? (
          <Hint>{t('metrics.helper.none')}</Hint>
        ) : (
          <>
            <Pair label={t('metrics.helper.minutes')} value={number(helper.minutes)} />
            <Pair
              label={t('metrics.helper.fps')}
              value={t('metrics.helper.fpsValue', {
                sent: helper.sentFps === null ? none : number(helper.sentFps, 1),
                captured: helper.capturedFps === null ? none : number(helper.capturedFps, 1),
              })}
            />
            <Pair
              label={t('metrics.helper.bitrate')}
              value={helper.sentKbps === null ? none : formatKbps(helper.sentKbps, locale)}
            />
            <Pair
              label={t('metrics.helper.cpu')}
              value={
                helper.cpuPct === null
                  ? none
                  : t('metrics.percentOfCore', { value: number(helper.cpuPct, 1) })
              }
            />
            <Pair
              label={t('metrics.helper.keyframes')}
              value={
                helper.keyframeRequestsPerHour === null
                  ? none
                  : number(helper.keyframeRequestsPerHour, 1)
              }
            />
            <Pair
              label={t('metrics.helper.idr')}
              value={
                helper.idrMaxBytes === null || helper.idrMaxBytes === 0
                  ? none
                  : t('metrics.kilobytes', { value: number(helper.idrMaxBytes / 1000) })
              }
            />
          </>
        )}
      </Card>
      <Card>
        <Heading>{t('metrics.errors.title')}</Heading>
        {summary.topErrors.length === 0 ? (
          <Hint>{t('metrics.errors.none')}</Hint>
        ) : (
          summary.topErrors.map((e) => <Pair key={e.code} label={e.code} value={number(e.count)} />)
        )}
        {summary.decodeErrors > 0 ? (
          <Hint>{t('metrics.errors.decode', { count: summary.decodeErrors })}</Hint>
        ) : null}
      </Card>
    </View>
  );
}

/** The web's formatBitrate: megabits from 1 Mbps up, kilobits below. */
function formatKbps(kbps: number, locale: string): string {
  const bps = kbps * 1000;
  return Math.abs(bps) >= 1_000_000
    ? new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: 'megabit-per-second',
        maximumFractionDigits: 1,
      }).format(bps / 1_000_000)
    : new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: 'kilobit-per-second',
        maximumFractionDigits: 0,
      }).format(bps / 1000);
}

const styles = StyleSheet.create({
  gap: { gap: 2 },
  summary: { gap: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 16 },
  metric: { width: '50%', gap: 2, paddingRight: 8 },
  eyebrow: { fontFamily: font.medium, fontSize: 12, textTransform: 'uppercase' },
  value: { fontFamily: font.semibold, fontSize: 24, fontVariant: ['tabular-nums'] },
  note: { fontFamily: font.regular, fontSize: 12 },
  pair: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  pairLabel: { fontFamily: font.regular, fontSize: 14, flexShrink: 1 },
  pairValue: { fontFamily: font.medium, fontSize: 14, fontVariant: ['tabular-nums'] },
});
