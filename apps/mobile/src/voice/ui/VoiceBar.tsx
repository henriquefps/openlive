// SPDX-License-Identifier: AGPL-3.0-only
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Button } from '../../components/ui.tsx';
import { font, radius, useTheme } from '../../theme.ts';
import { voiceSessions } from '../host.ts';
import { useActiveVoice, useVoiceSessionsState } from '../hooks.ts';
import type { RoomLink } from '../parts.ts';
import { voiceControls } from '../view.ts';

const FADE = 'fade';
const BOTTOM = ['bottom'] as const;

/**
 * "In voice in #room", with mute, and a way back, on every screen but the room's own: the call
 * outlives the room screen (the notification has the same Mute and Leave).
 */
export function VoiceBar({ onOpenRoom }: { onOpenRoom: (roomId: string, link: RoomLink) => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const active = useActiveVoice();
  if (!active || active.viewed || !active.link) return null;
  const { voice, session, link } = active;
  const c = voiceControls(voice);
  return (
    <SafeAreaView edges={BOTTOM} style={{ backgroundColor: colors.card }}>
      <View style={[styles.bar, { borderColor: colors.border, backgroundColor: colors.card }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('mobile.voice.barRoom', { room: active.name })}
          onPress={() => onOpenRoom(session.roomId, link)}
          style={styles.grow}
        >
          <Text style={[styles.title, { color: colors.primary }]} numberOfLines={1}>
            {c.joined ? t('voice.session.connected') : t('voice.session.connecting')}
          </Text>
          <Text style={[styles.room, { color: colors.mutedForeground }]} numberOfLines={1}>
            {active.name}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!c.joined || !c.canMute}
          onPress={() => session.parts.client.setMuted(!voice.muted)}
          style={[styles.button, { borderColor: colors.border }, !c.canMute && { opacity: 0.5 }]}
        >
          <Text style={[styles.buttonText, { color: colors.foreground }]}>
            {voice.muted ? t('voice.unmute') : t('voice.mute')}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => voiceSessions.leave()}
          style={[styles.button, { borderColor: colors.destructive }]}
        >
          <Text style={[styles.buttonText, { color: colors.destructive }]}>{t('voice.leave')}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

/** "Switch to <room>?": joining voice here leaves the other room's voice. */
export function SwitchDialog() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { pendingSwitch } = useVoiceSessionsState();
  if (!pendingSwitch) return null;
  return (
    <Modal transparent animationType={FADE} onRequestClose={() => voiceSessions.cancelSwitch()}>
      <View style={styles.backdrop}>
        <View style={[styles.dialog, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.foreground, fontSize: 18 }]}>
            {t('voice.session.switchTitle', { room: pendingSwitch.to.name })}
          </Text>
          <Body muted>{t('voice.session.switchBody', { room: pendingSwitch.from.name })}</Body>
          <Button label={t('voice.session.switch')} onPress={() => voiceSessions.confirmSwitch()} />
          <Button
            label={t('mobile.voice.cancel')}
            variant="outline"
            onPress={() => voiceSessions.cancelSwitch()}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
  },
  grow: { flex: 1, minHeight: 44, justifyContent: 'center' },
  title: { fontFamily: font.semibold, fontSize: 14 },
  room: { fontFamily: font.regular, fontSize: 13 },
  button: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: radius.control,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontFamily: font.medium, fontSize: 14 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: 24,
  },
  dialog: { borderRadius: radius.card, borderWidth: 1, padding: 16, gap: 12 },
});
