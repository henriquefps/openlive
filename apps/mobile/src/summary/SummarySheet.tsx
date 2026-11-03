// SPDX-License-Identifier: AGPL-3.0-only
import type { TFunction } from 'i18next';
import { At, Broadcast, ChatCircle, X } from 'phosphor-react-native';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { font, radius, useTheme } from '../theme.ts';
import { clock, type ServerSummary, type SummaryItem } from './model.ts';

const SLIDE = 'slide';
const PASS_THROUGH = 'box-none';
const BOTTOM = ['bottom'] as const;

/**
 * What happened while the app was away, per server: a short list, each line a room to open. A card
 * from the bottom over the screen; tapping outside or the close button leaves it.
 */
export function SummarySheet({
  summary,
  onOpenRoom,
  onClose,
}: {
  summary: readonly ServerSummary[];
  onOpenRoom: (origin: string, item: SummaryItem) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  return (
    <Modal
      visible={summary.length > 0}
      transparent
      animationType={SLIDE}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityLabel={t('summary.close')}
      />
      <SafeAreaView edges={BOTTOM} style={styles.sheetHost} pointerEvents={PASS_THROUGH}>
        <View style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.header}>
            <Text
              accessibilityRole="header"
              style={[styles.title, { color: colors.foreground }]}
              numberOfLines={1}
            >
              {t('summary.title')}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('summary.close')}
              onPress={onClose}
              hitSlop={12}
            >
              <X size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {summary.map((server) => (
              <View key={server.origin} style={styles.server}>
                <Text
                  style={[styles.serverName, { color: colors.mutedForeground }]}
                  numberOfLines={1}
                >
                  {server.serverName}
                </Text>
                {server.items.map((item) => (
                  <Pressable
                    key={`${item.kind}/${item.roomId}/${item.kind === 'stream' ? item.at : ''}`}
                    accessibilityRole="button"
                    onPress={() => onOpenRoom(server.origin, item)}
                    style={[styles.item, { borderColor: colors.border }]}
                  >
                    <ItemIcon item={item} color={colors.primary} />
                    <Text style={[styles.itemText, { color: colors.foreground }]} numberOfLines={2}>
                      {itemText(item, t, i18n.language)}
                    </Text>
                  </Pressable>
                ))}
                {server.more > 0 ? (
                  <Text style={[styles.more, { color: colors.mutedForeground }]}>
                    {t('summary.more', { count: server.more })}
                  </Text>
                ) : null}
              </View>
            ))}
          </ScrollView>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function ItemIcon({ item, color }: { item: SummaryItem; color: string }) {
  const Icon = item.kind === 'stream' ? Broadcast : item.kind === 'mentions' ? At : ChatCircle;
  return <Icon size={20} color={color} weight={item.kind === 'unread' ? 'regular' : 'fill'} />;
}

/** "Ana streamed at 20:15 in geral", "3 mentions in geral", "2 unread messages in geral". */
export function itemText(item: SummaryItem, t: TFunction, locale: string): string {
  switch (item.kind) {
    case 'stream':
      return t('summary.stream', {
        who: item.who,
        time: clock(item.at, locale),
        room: item.roomName,
      });
    case 'mentions':
      return t('summary.mentions', { count: item.count, room: item.roomName });
    case 'unread':
      return t('summary.unread', { count: item.count, room: item.roomName });
  }
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheetHost: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    marginHorizontal: 8,
    marginBottom: 8,
    maxHeight: '70%',
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 14,
    paddingHorizontal: 14,
    paddingBottom: 6,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontFamily: font.semibold, fontSize: 17, flex: 1 },
  list: { flexGrow: 0 },
  listContent: { paddingVertical: 8, gap: 12 },
  server: { gap: 2 },
  serverName: { fontFamily: font.medium, fontSize: 12, textTransform: 'uppercase' },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  itemText: { fontFamily: font.regular, fontSize: 14, flex: 1 },
  more: { fontFamily: font.regular, fontSize: 12, paddingTop: 6 },
});
