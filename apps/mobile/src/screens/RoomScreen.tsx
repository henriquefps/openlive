// SPDX-License-Identifier: AGPL-3.0-only
import { unreadLabel } from '@openlive/client';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Avatar,
  Badge,
  AvatarSourceProvider,
  Banner,
  Body,
  Button,
  Card,
  Empty,
  LiveDot,
  Screen,
  SectionLabel,
} from '../components/ui.tsx';
import { BROADCAST, Glyph, PLAY } from '../components/Glyph.tsx';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { OfflineHint } from '../components/OfflineHint.tsx';
import { useApi, useAuthHeaders, useRoom } from '../hooks.ts';
import i18n from '../i18n/index.ts';
import {
  endedText,
  roomNotice,
  type StreamCard,
  sortedMembers,
  streamCards,
  thumbnailUrl,
} from '../lib/room-view.ts';
import type { SavedInstance } from '../lib/storage.ts';
import { StreamView } from '../player/index.tsx';
import { font, radius, useTheme } from '../theme.ts';
import { setChatOpen } from '../notices/notify.ts';
import { useRoomNotices } from '../notices/watchers.tsx';
import { useRoomVoice } from '../voice/hooks.ts';
import { VoiceSection } from '../voice/ui/VoiceSection.tsx';

type Tab = 'live' | 'chat';
const LIVE: Tab = 'live';
const CHAT: Tab = 'chat';
const COVER = 'cover';
const KEYBOARD_BEHAVIOR = 'padding';

/**
 * A room: who is in it, its live streams (each with a Watch button) and its chat, over the room
 * socket. The socket reconnects by itself; the banner says what it is doing.
 */
export function RoomScreen({
  instance,
  spaceId,
  roomId,
  roomName,
  onBack,
}: {
  instance: SavedInstance;
  spaceId: string;
  roomId: string;
  roomName: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const api = useApi(instance.origin);
  const [session, setSession] = useState(0);
  const { connection, chat, room, chatState, roomStale } = useRoom(
    api,
    instance.origin,
    roomId,
    session,
  );
  // The room's voice: its own socket and SFU session, held while this screen shows the room and
  // after it (the call goes on; see voice/host.ts).
  const voice = useRoomVoice(
    roomId,
    { origin: instance.origin, spaceId, roomName, serverName: instance.name },
    room.settings,
  );
  const headers = useAuthHeaders(api);
  const [tab, setTab] = useState<Tab>('live');
  const [watching, setWatching] = useState<string | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (s) => setForeground(s === 'active'));
    return () => subscription.remove();
  }, []);

  // Back closes the player first.
  useEffect(() => {
    if (watching === null) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setWatching(null);
      return true;
    });
    return () => subscription.remove();
  }, [watching]);

  const chatAvailable = chatState.status !== 'off' || room.status !== 'open';
  const shown: Tab = tab === 'chat' && chatAvailable ? 'chat' : 'live';
  // Messages count as read while the chat is in front of the reader.
  useEffect(() => {
    chat?.setActive(shown === 'chat' && watching === null && foreground);
    return () => chat?.setActive(false);
  }, [chat, shown, watching, foreground]);

  // The room's cues and toasts (streams, viewers, slots) from this screen's socket; a room with
  // voice has its voice socket's watcher already.
  const target = useMemo(
    () => ({ origin: instance.origin, spaceId, roomId, roomName }),
    [instance.origin, spaceId, roomId, roomName],
  );
  useRoomNotices(connection, !voice.hasVoice, target, t);
  // Its mentions are in front of the reader while the chat shows.
  useEffect(() => {
    if (shown !== 'chat' || watching !== null || !foreground) return;
    setChatOpen(roomId);
    return () => setChatOpen(null);
  }, [roomId, shown, watching, foreground]);

  const showLive = () => setTab(LIVE);
  const showChat = () => setTab(CHAT);
  const members = room.members;
  const cards = useMemo(
    () => streamCards(room.streams, members, room.viewers),
    [room.streams, room.viewers, members],
  );
  const notice = roomNotice(room);
  const refreshing = session > 0 && room.status !== 'open' && room.status !== 'ended';

  // A stream that ended while watching: the player closes with it.
  const streamGone =
    watching !== null &&
    room.status === 'open' &&
    !room.streams.some((s) => s.streamId === watching);
  if (streamGone) setWatching(null);

  if (watching !== null) {
    return (
      <StreamView
        instance={instance}
        roomId={roomId}
        streamId={watching}
        onClose={() => setWatching(null)}
      />
    );
  }

  const title = room.room?.name ?? roomName;
  const online = room.status === 'open';
  return (
    <AvatarSourceProvider origin={instance.origin} headers={headers}>
      <Screen
        title={title}
        subtitle={instance.name}
        onBack={onBack}
        backLabel={t('common.back')}
        scroll={shown === 'live'}
        refreshing={refreshing}
        onRefresh={() => setSession((n) => n + 1)}
      >
        <View style={[styles.tabs, { backgroundColor: colors.muted }]} accessibilityRole="tablist">
          <TabButton
            label={t('mobile.room.tabLive')}
            active={shown === 'live'}
            onPress={showLive}
          />
          {chatAvailable ? (
            <TabButton
              label={t('chat.title')}
              active={shown === 'chat'}
              onPress={showChat}
              badge={chatState.unread > 0 ? unreadLabel(chatState.unread) : undefined}
            />
          ) : null}
        </View>

        <OfflineHint hasData={roomStale || room.you !== null} />
        {notice ? (
          <Banner tone={notice.kind === 'ended' ? 'destructive' : 'warning'}>
            {notice.kind === 'connecting'
              ? t('room.connection.connecting')
              : notice.kind === 'reconnecting'
                ? notice.quota
                  ? t('room.connection.quotaExceeded')
                  : t('room.connection.reconnecting')
                : t(endedText(notice.end).key)}
          </Banner>
        ) : null}
        {notice?.kind === 'ended' && endedText(notice.end).retry ? (
          <Button
            label={t('room.connection.useHere')}
            variant="outline"
            onPress={() => connection?.reconnect()}
          />
        ) : null}
        {room.error && room.status === 'open' ? (
          <Banner tone="destructive">
            {t(`errors.${room.error.code}`, {
              defaultValue: t('errors.generic', { code: room.error.code }),
            })}
          </Banner>
        ) : null}

        {shown === 'live' ? (
          <>
            {voice.hasVoice && (online || voice.inVoice) ? <VoiceSection voice={voice} /> : null}
            {cards.length > 0 ? <SectionLabel>{t('room.streams')}</SectionLabel> : null}
            {cards.length === 0 ? (
              <Empty
                title={t('room.empty.title')}
                hint={online ? t('room.empty.description') : undefined}
              />
            ) : (
              cards.map((card) => (
                <StreamCardView
                  key={card.streamId}
                  card={card}
                  thumbnail={
                    card.thumbnailAt !== null && headers
                      ? {
                          uri: thumbnailUrl(instance.origin, card.streamId, card.thumbnailAt),
                          headers,
                        }
                      : null
                  }
                  onWatch={() => setWatching(card.streamId)}
                />
              ))
            )}
            <SectionLabel>
              {room.status === 'open'
                ? t('room.present.title', { count: members.length })
                : t('room.present.titleNoCount')}
            </SectionLabel>
            {members.length === 0 ? (
              <Body muted>{t('room.present.empty')}</Body>
            ) : (
              <Card>
                {sortedMembers(members, room.you?.userId ?? null).map((m) => (
                  <View key={m.userId} style={styles.member}>
                    <Avatar name={m.displayName} url={m.avatarUrl} size={28} />
                    <Text style={[styles.person, { color: colors.foreground }]} numberOfLines={1}>
                      {m.displayName}
                    </Text>
                    {m.role !== 'member' ? (
                      <Text style={[styles.meta, { color: colors.mutedForeground }]}>
                        {t(`roles.${m.role}`)}
                      </Text>
                    ) : null}
                    {m.canStream && m.role === 'guest' ? (
                      <View accessible accessibilityLabel={t('room.present.canStream')}>
                        <Glyph name={BROADCAST} size={14} color={colors.foreground} />
                      </View>
                    ) : null}
                  </View>
                ))}
              </Card>
            )}
          </>
        ) : chat ? (
          <KeyboardAvoidingView style={styles.fill} behavior={KEYBOARD_BEHAVIOR}>
            <ChatPanel
              chat={chat}
              state={chatState}
              you={room.you}
              members={members}
              online={online}
              quick={room.room?.kind === 'quick'}
              retentionDays={room.settings?.chatRetentionDays}
              locale={i18n.language}
            />
          </KeyboardAvoidingView>
        ) : null}
      </Screen>
    </AvatarSourceProvider>
  );
}

function TabButton({
  label,
  active,
  onPress,
  badge,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  badge?: string | undefined;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.tab, active && { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <Text
        style={[styles.tabText, { color: active ? colors.foreground : colors.mutedForeground }]}
      >
        {label}
      </Text>
      {badge ? <Badge label={badge} tone="destructive" /> : null}
    </Pressable>
  );
}

/**
 * A live stream: the whole card opens it. Thumbnail on top when the room has one (the instance
 * wants the app token for it), the streamer's photo and name, a small red dot, the viewers.
 */
function StreamCardView({
  card,
  thumbnail,
  onWatch,
}: {
  card: StreamCard;
  thumbnail: { uri: string; headers: Record<string, string> } | null;
  onWatch: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [broken, setBroken] = useState<string | null>(null);
  const name = card.streamer ?? t('mobile.space.someone');
  const image = thumbnail && thumbnail.uri !== broken ? thumbnail : null;
  const meta = [t(`presets.${card.preset}`), card.source].filter(Boolean).join(' · ');
  const viewers = t('mobile.room.viewers', { count: card.viewers, limit: card.viewerLimit });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t('room.live.watch')}: ${t('room.live.streaming', { name })}`}
      onPress={onWatch}
      style={({ pressed }) => [
        styles.stream,
        { backgroundColor: colors.card, borderColor: colors.border },
        pressed && { opacity: 0.7 },
      ]}
    >
      {image ? (
        <Image
          source={image}
          style={styles.thumbnail}
          resizeMode={COVER}
          onError={() => setBroken(image.uri)}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      <View style={styles.streamRow}>
        <Avatar name={name} url={card.streamerAvatar} size={36} />
        <View style={styles.grow}>
          <View style={styles.titleLine}>
            {card.paused ? null : <LiveDot />}
            <Text style={[styles.person, { color: colors.foreground }]} numberOfLines={1}>
              {name}
            </Text>
            {card.paused ? <Badge label={t('mobile.room.paused')} tone="muted" /> : null}
          </View>
          <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
            {meta} · {viewers}
          </Text>
        </View>
        <Glyph name={PLAY} size={16} color={colors.primary} weight="fill" />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1, gap: 1 },
  member: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36 },
  stream: { borderWidth: 1, borderRadius: radius.card, overflow: 'hidden' },
  thumbnail: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' },
  streamRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tabs: { flexDirection: 'row', borderRadius: radius.control, padding: 3, gap: 3 },
  tab: {
    flex: 1,
    minHeight: 36,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.control - 2,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  tabText: { fontFamily: font.medium, fontSize: 15 },
  person: { flex: 1, fontFamily: font.medium, fontSize: 15 },
  meta: { fontFamily: font.regular, fontSize: 13 },
});
