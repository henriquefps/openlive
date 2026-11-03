// SPDX-License-Identifier: AGPL-3.0-only
import { unreadLabel } from '@openlive/client';
import type { TFunction } from 'i18next';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { Badge, Banner, Body, Button, Card, Empty, Row, Screen } from '../components/ui.tsx';
import { OfflineHint } from '../components/OfflineHint.tsx';
import { useApi, useSpacePresence } from '../hooks.ts';
import { errorText } from '../i18n/errors.ts';
import { isUnauthenticated } from '../lib/api.ts';
import { useRooms, useUnread } from '../queries.ts';
import { namesWithMore, type RoomRow, roomRows, streamerNames } from '../lib/presence.ts';
import { font, useTheme } from '../theme.ts';

/** How many names a room row spells out before "+N more". */
const NAMES = 3;

/**
 * A space: its rooms, each with who is in voice, who streams (the space socket, live) and its
 * unread chat messages. Pull down to load the rooms and the unread counts again.
 */
export function SpaceScreen({
  origin,
  spaceId,
  spaceName,
  serverName,
  refreshKey,
  onBack,
  onOpenRoom,
}: {
  origin: string;
  spaceId: string;
  spaceName: string;
  serverName: string;
  /** Changes when a room was closed, so the unread counts are fetched again. */
  refreshKey: number;
  onBack: () => void;
  onOpenRoom: (roomId: string, roomName: string) => void;
}) {
  const { t } = useTranslation();
  const api = useApi(origin);
  const presence = useSpacePresence(api, origin, spaceId);
  const rooms = useRooms(origin, spaceId);
  // Unread counts are a separate call: a failure there must not hide the rooms.
  const unread = useUnread(origin, spaceId);

  const refetchUnread = unread.refetch;
  useEffect(() => {
    if (refreshKey > 0) void refetchUnread();
  }, [refreshKey, refetchUnread]);

  const rows = useMemo(
    () => (rooms.data ? roomRows(rooms.data, presence.rooms, unread.data ?? {}) : []),
    [rooms.data, presence.rooms, unread.data],
  );

  // Pull to refresh: the spinner is the pull's own, not the background revalidation's.
  const [pulling, setPulling] = useState(false);
  const reload = () => {
    setPulling(true);
    void Promise.all([rooms.refetch(), unread.refetch()]).finally(() => setPulling(false));
  };

  // An error only replaces the rooms when there is nothing saved to show.
  const failed = rooms.data === undefined && rooms.isError ? rooms.error : null;
  return (
    <Screen
      title={spaceName}
      subtitle={serverName}
      onBack={onBack}
      backLabel={t('common.back')}
      refreshing={pulling}
      onRefresh={reload}
    >
      <OfflineHint hasData={rooms.data !== undefined} />
      {presence.status === 'reconnecting' ? (
        <Banner>{t('mobile.space.reconnecting')}</Banner>
      ) : null}
      {presence.status === 'ended' ? (
        <Banner tone="muted">{t('mobile.space.presenceEnded')}</Banner>
      ) : null}
      {failed ? (
        <Card>
          <Body tone="destructive">
            {isUnauthenticated(failed) ? t('errors.unauthenticated') : errorText(t, failed)}
          </Body>
          <Button label={t('common.retry')} variant="outline" onPress={reload} />
        </Card>
      ) : null}
      {rooms.isPending && rooms.fetchStatus !== 'paused' ? (
        <Body muted>{t('mobile.loading')}</Body>
      ) : null}
      {rooms.data !== undefined && rows.length === 0 ? (
        <Empty title={t('mobile.space.noRooms')} hint={t('mobile.space.noRoomsHint')} />
      ) : null}
      {rows.map((row) => (
        <RoomCard
          key={row.room.id}
          row={row}
          onPress={() => onOpenRoom(row.room.id, row.room.name)}
        />
      ))}
    </Screen>
  );
}

function RoomCard({ row, onPress }: { row: RoomRow; onPress: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const voice = namesWithMore(
    row.voice.map((v) => v.displayName),
    NAMES,
  );
  const live = namesWithMore(streamerNames(row.live), NAMES);
  const quiet = row.voice.length === 0 && row.live.length === 0;
  return (
    <Card onPress={onPress}>
      <Row>
        <View style={styles.grow}>
          <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
            {row.room.kind === 'quick'
              ? `${row.room.name} · ${row.room.code ?? ''}`
              : row.room.name}
          </Text>
          {quiet ? (
            <Text style={[styles.meta, { color: colors.mutedForeground }]}>
              {t('mobile.space.quiet')}
            </Text>
          ) : null}
        </View>
        {row.live.length > 0 ? <Badge label={t('mobile.space.live')} /> : null}
        {row.unread > 0 ? (
          <View accessibilityLabel={t('chat.unread', { count: row.unread })}>
            <Badge label={unreadLabel(row.unread)} tone="destructive" />
          </View>
        ) : null}
      </Row>
      {row.live.length > 0 ? (
        <Text style={[styles.meta, { color: colors.foreground }]} numberOfLines={2}>
          {t('mobile.space.streaming', {
            names: joinNames(live.shown, live.more, t('mobile.space.someone'), t),
          })}
        </Text>
      ) : null}
      {row.voice.length > 0 ? (
        <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={2}>
          {t('mobile.space.inVoice', {
            names: joinNames(voice.shown, voice.more, '', t),
          })}
        </Text>
      ) : null}
    </Card>
  );
}

function joinNames(shown: string[], more: number, fallback: string, t: TFunction): string {
  const list = shown.length > 0 ? shown.join(', ') : fallback;
  return more > 0 ? `${list}, ${t('app.sidebar.morePeople', { count: more })}` : list;
}

const styles = StyleSheet.create({
  grow: { flex: 1, gap: 2 },
  name: { fontFamily: font.medium, fontSize: 16 },
  meta: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
});
