// SPDX-License-Identifier: AGPL-3.0-only
import {
  CHAT_MAX_CHARS,
  type ChatClient,
  type ChatEntry,
  type ChatState,
  charCount,
} from '@openlive/client';
import type { Member, You } from '@openlive/protocol';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { errorText } from '../i18n/errors.ts';
import { segments } from '../lib/chat-text.ts';
import {
  chatPeople,
  insertMention,
  mentioned,
  mentionsYou,
  mentionSuggestions,
  messageActions,
  messageTime,
  newestFirst,
  overLimit,
  type Person,
  retentionLine,
  showCounter,
} from '../lib/chat-view.ts';
import { mentionQuery } from '../lib/chat-text.ts';
import { font, radius, useTheme } from '../theme.ts';
import { Avatar, Banner, Body } from './ui.tsx';

/** The room's chat: history (older pages as you scroll up), send, edit and delete, mentions. */
export function ChatPanel({
  chat,
  state,
  you,
  members,
  online,
  quick,
  retentionDays,
  locale,
}: {
  chat: ChatClient;
  state: ChatState;
  you: You | null;
  members: readonly Member[];
  /** The room socket is open: sending needs it. */
  online: boolean;
  quick: boolean;
  retentionDays: number | undefined;
  locale: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const selfId = you?.userId ?? null;
  const people = useMemo(() => chatPeople(members, state.messages), [members, state.messages]);
  const data = useMemo(() => newestFirst(state.messages), [state.messages]);
  const [editing, setEditing] = useState<ChatEntry | null>(null);
  // "Today" for the times, fixed while the panel is open.
  const [now] = useState(Date.now);

  const onAction = useCallback(
    (message: ChatEntry) => {
      const actions = messageActions(message, you);
      if (actions.length === 0) return;
      const buttons = actions.flatMap((action) => {
        switch (action) {
          case 'edit':
            return [{ text: t('chat.edit'), onPress: () => setEditing(message) }];
          case 'delete':
            return [
              {
                text:
                  message.userId === selfId ? t('chat.delete.action') : t('chat.delete.moderate'),
                style: 'destructive' as const,
                onPress: () => confirmDelete(message, selfId, chat, t),
              },
            ];
          case 'retry':
            return [{ text: t('chat.retry'), onPress: () => chat.retry(message.clientId ?? '') }];
          case 'discard':
            return [
              {
                text: t('chat.discard'),
                style: 'destructive' as const,
                onPress: () => chat.discard(message.clientId ?? ''),
              },
            ];
        }
      });
      Alert.alert(t('chat.actions', { name: message.authorName }), undefined, [
        ...buttons,
        { text: t('common.cancel'), style: 'cancel' },
      ]);
    },
    [chat, selfId, t, you],
  );

  // A refused edit or delete: said once, then cleared.
  useEffect(() => {
    if (!state.error) return;
    const timer = setTimeout(() => chat.clearError(), 5000);
    return () => clearTimeout(timer);
  }, [state.error, chat]);

  const canWrite = state.status === 'ready' && you?.permissions.canWriteChat !== false;
  const retention = retentionLine(retentionDays, quick);
  return (
    <View style={styles.panel}>
      <Text style={[styles.retention, { color: colors.mutedForeground }]} numberOfLines={1}>
        {t(retention.key, retention.count === undefined ? {} : { count: retention.count })}
      </Text>
      {state.error ? <Banner tone="destructive">{errorText(t, state.error)}</Banner> : null}
      {state.status === 'off' ? (
        <View style={styles.center}>
          <Body muted>{t('mobile.chat.off')}</Body>
        </View>
      ) : state.status === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : state.messages.length === 0 ? (
        <View style={styles.center}>
          <Body muted>{t('chat.empty')}</Body>
        </View>
      ) : (
        <FlatList
          inverted
          style={styles.list}
          data={data}
          keyExtractor={(m) => m.id}
          keyboardShouldPersistTaps="handled"
          onEndReached={() => chat.loadOlder()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            state.loadingOlder ? (
              <ActivityIndicator color={colors.primary} style={styles.older} />
            ) : undefined
          }
          renderItem={({ item }) => (
            <MessageRow
              message={item}
              selfId={selfId}
              people={people}
              locale={locale}
              now={now}
              onLongPress={onAction}
              onRetry={(m) => chat.retry(m.clientId ?? '')}
              onDiscard={(m) => chat.discard(m.clientId ?? '')}
            />
          )}
        />
      )}
      {!online && state.status !== 'off' ? <Banner tone="muted">{t('chat.offline')}</Banner> : null}
      {state.status === 'ready' && !canWrite ? <Body muted>{t('chat.readOnly')}</Body> : null}
      {canWrite ? (
        <Composer
          // Starting an edit starts a new box, with the message's text in it.
          key={editing?.id ?? 'new'}
          chat={chat}
          people={people}
          selfId={selfId}
          online={online}
          editing={editing}
          onDone={() => setEditing(null)}
        />
      ) : null}
    </View>
  );
}

function confirmDelete(
  message: ChatEntry,
  selfId: string | null,
  chat: ChatClient,
  t: (key: string) => string,
) {
  Alert.alert(
    t('chat.delete.title'),
    message.userId === selfId ? t('chat.delete.own') : t('chat.delete.other'),
    [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('chat.delete.action'),
        style: 'destructive',
        onPress: () => chat.delete(message.id),
      },
    ],
  );
}

const MessageRow = memo(function MessageRow({
  message,
  selfId,
  people,
  locale,
  now,
  onLongPress,
  onRetry,
  onDiscard,
}: {
  message: ChatEntry;
  selfId: string | null;
  people: readonly Person[];
  locale: string;
  now: number;
  onLongPress: (message: ChatEntry) => void;
  onRetry: (message: ChatEntry) => void;
  onDiscard: (message: ChatEntry) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const pieces = useMemo(
    () => segments(message.text, mentioned(message, people)),
    [message, people],
  );
  const mine = message.userId !== undefined && message.userId === selfId;
  const toYou = mentionsYou(message, selfId);
  const name = message.authorName === '' ? t('chat.accountRemoved') : message.authorName;
  return (
    <Pressable
      onLongPress={() => onLongPress(message)}
      delayLongPress={350}
      accessibilityHint={t('chat.actions', { name })}
      style={[
        styles.message,
        toYou && {
          backgroundColor: colors.muted,
          borderLeftColor: colors.primary,
          borderLeftWidth: 3,
        },
        message.pending && { opacity: 0.6 },
      ]}
    >
      <Avatar name={name} size={32} />
      <View style={styles.grow}>
        <View style={styles.head}>
          <Text style={[styles.author, { color: colors.foreground }]} numberOfLines={1}>
            {mine ? `${name}` : name}
          </Text>
          <Text style={[styles.time, { color: colors.mutedForeground }]}>
            {messageTime(message.createdAt, now, locale)}
            {message.editedAt ? ` ${t('chat.edited')}` : ''}
          </Text>
        </View>
        <Text selectable style={[styles.body, { color: colors.foreground }]}>
          {pieces.map((piece, i) => {
            if (piece.kind === 'link') {
              return (
                <Text
                  key={i}
                  style={{ color: colors.primary, textDecorationLine: 'underline' }}
                  onPress={() => void Linking.openURL(piece.href).catch(() => undefined)}
                  accessibilityRole="link"
                >
                  {piece.text}
                </Text>
              );
            }
            if (piece.kind === 'mention') {
              return (
                <Text
                  key={i}
                  style={{
                    fontFamily: font.semibold,
                    color: colors.primary,
                    backgroundColor: piece.userId === selfId ? colors.muted : undefined,
                  }}
                >
                  {piece.text}
                </Text>
              );
            }
            return piece.text;
          })}
        </Text>
        {message.failed ? (
          <View style={styles.failed}>
            <Text style={[styles.meta, { color: colors.destructive }]}>
              {t('chat.failed')} {errorText(t, message.failed)}
            </Text>
            <View style={styles.failedActions}>
              <Pressable accessibilityRole="button" onPress={() => onRetry(message)} hitSlop={8}>
                <Text style={[styles.link, { color: colors.primary }]}>{t('chat.retry')}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => onDiscard(message)} hitSlop={8}>
                <Text style={[styles.link, { color: colors.destructive }]}>
                  {t('chat.discard')}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});

function Composer({
  chat,
  people,
  selfId,
  online,
  editing,
  onDone,
}: {
  chat: ChatClient;
  people: readonly Person[];
  selfId: string | null;
  online: boolean;
  editing: ChatEntry | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [text, setText] = useState(editing?.text ?? '');
  const [caret, setCaret] = useState(editing?.text.length ?? 0);

  const query = mentionQuery(text, caret);
  const suggestions = query ? mentionSuggestions(people, query.query, selfId) : [];
  const empty = text.trim() === '';
  const blocked = empty || overLimit(text) || (!editing && !online) || (editing && !online);

  const submit = () => {
    if (blocked) return;
    if (editing) chat.edit(editing.id, text);
    else chat.send(text);
    setText('');
    setCaret(0);
    onDone();
  };
  const cancel = () => {
    setText('');
    setCaret(0);
    onDone();
  };
  const pick = (person: Person) => {
    const next = insertMention(text, caret, person.name);
    if (!next) return;
    setText(next.value);
    setCaret(next.caret);
  };

  return (
    <View style={styles.composer}>
      {editing ? (
        <View style={styles.editing}>
          <Text style={[styles.meta, { color: colors.mutedForeground }]}>
            {t('chat.editLabel')}
          </Text>
          <Pressable accessibilityRole="button" onPress={cancel} hitSlop={8}>
            <Text style={[styles.link, { color: colors.primary }]}>{t('common.cancel')}</Text>
          </Pressable>
        </View>
      ) : null}
      {suggestions.length > 0 ? (
        <View
          accessibilityLabel={t('chat.mentionSuggestions')}
          style={[styles.suggestions, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          {suggestions.map((p) => (
            <Pressable
              key={p.userId}
              accessibilityRole="button"
              onPress={() => pick(p)}
              style={styles.suggestion}
            >
              <Avatar name={p.name} size={24} />
              <Text style={[styles.body, { color: colors.foreground }]} numberOfLines={1}>
                {p.name}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.inputRow}>
        <TextInput
          autoFocus={editing !== null}
          value={text}
          onChangeText={setText}
          onSelectionChange={(e) => setCaret(e.nativeEvent.selection.end)}
          placeholder={t('chat.placeholder')}
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel={t('chat.inputLabel')}
          multiline
          style={[
            styles.input,
            { color: colors.foreground, backgroundColor: colors.card, borderColor: colors.border },
          ]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={editing ? t('common.save') : t('chat.send')}
          accessibilityState={{ disabled: Boolean(blocked) }}
          disabled={Boolean(blocked)}
          onPress={submit}
          style={[styles.send, { backgroundColor: colors.primary }, blocked && { opacity: 0.4 }]}
        >
          <Text style={[styles.sendText, { color: colors.primaryForeground }]}>
            {editing ? t('common.save') : t('chat.send')}
          </Text>
        </Pressable>
      </View>
      {showCounter(text) ? (
        <Text
          style={[
            styles.meta,
            { color: overLimit(text) ? colors.destructive : colors.mutedForeground },
          ]}
        >
          {t('chat.counter', { count: charCount(text), max: CHAT_MAX_CHARS })}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, gap: 8 },
  retention: { fontFamily: font.regular, fontSize: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1 },
  older: { padding: 12 },
  message: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderRadius: radius.control,
  },
  grow: { flex: 1, gap: 2 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  author: { fontFamily: font.semibold, fontSize: 14, flexShrink: 1 },
  time: { fontFamily: font.regular, fontSize: 12 },
  body: { fontFamily: font.regular, fontSize: 15, lineHeight: 21 },
  meta: { fontFamily: font.regular, fontSize: 12, lineHeight: 17 },
  link: { fontFamily: font.medium, fontSize: 13 },
  failed: { gap: 4 },
  failedActions: { flexDirection: 'row', gap: 16 },
  composer: { gap: 6 },
  editing: { flexDirection: 'row', justifyContent: 'space-between' },
  suggestions: { borderWidth: 1, borderRadius: radius.control, overflow: 'hidden' },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 40,
    paddingHorizontal: 10,
  },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    borderWidth: 1,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    fontFamily: font.regular,
    fontSize: 16,
  },
  send: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { fontFamily: font.medium, fontSize: 15 },
});
