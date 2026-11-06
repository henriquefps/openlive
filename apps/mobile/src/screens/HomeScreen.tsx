// SPDX-License-Identifier: AGPL-3.0-only
import Constants from 'expo-constants';
import type { JoinByCodeResult } from '@openlive/client';
import { ArrowCircleUp, GearSix, HardDrives, Hash, X } from 'phosphor-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSyncExternalStore } from 'react';
import { noticeSettings } from '../notices/notify.ts';
import { Button, Card, InstanceIcon, Row, Screen, Toggle } from '../components/ui.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Separator } from '../components/ui/Separator.tsx';
import { useAppUpdate } from '../app-update.tsx';
import { sizeInMb } from '../lib/app-update.ts';
import { hostOf } from '../lib/host.ts';
import { useInstances } from '../state.tsx';
import { JoinRoomSheet } from './JoinRoomSheet.tsx';
import { font, useTheme } from '../theme.ts';

/** The instances on this phone, like the accounts of a Mastodon app: tap one to switch to it. */
export function HomeScreen({
  current,
  onOpen,
  onAdd,
  onVoiceDebug,
  onSettings,
  onScan,
  onJoinedRoom,
}: {
  current: string | null;
  onOpen: (origin: string) => void;
  onAdd: () => void;
  onVoiceDebug: () => void;
  onSettings: () => void;
  onScan: () => void;
  /** A quick room joined by its code, on `origin`. */
  onJoinedRoom: (origin: string, joined: JoinByCodeResult) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { instances } = useInstances();
  // Tapping the version five times shows the voice test: a debug screen, not for everyday use.
  const [taps, setTaps] = useState(0);
  const [joining, setJoining] = useState(false);
  const { update, dismiss } = useAppUpdate();
  const mb = update ? sizeInMb(update.size) : null;
  const canJoin = instances.some((i) => i.user);
  // The cues of the notices (the web's "mute all sounds", kept on this phone): the toasts stay.
  const settings = useSyncExternalStore(noticeSettings.subscribe, noticeSettings.get);
  return (
    <Screen
      title={t('home.title')}
      headerRight={
        <Button
          size={ICON}
          variant="ghost"
          label={t('settings.open')}
          onPress={onSettings}
          icon={<GearSix size={22} color={colors.foreground} />}
        />
      }
    >
      {update ? (
        <Card>
          <Row>
            <ArrowCircleUp size={24} color={colors.primary} />
            <View style={styles.grow}>
              <Text style={[styles.name, { color: colors.foreground }]}>
                {t('home.update.title')}
              </Text>
              <Text style={[styles.meta, { color: colors.mutedForeground }]}>
                {mb
                  ? t('home.update.versionSize', { version: update.version, size: mb })
                  : t('home.update.version', { version: update.version })}
              </Text>
            </View>
            <Button
              size="icon"
              variant="ghost"
              label={t('home.update.dismiss')}
              onPress={dismiss}
              icon={<X size={18} color={colors.mutedForeground} />}
            />
          </Row>
          <Button
            label={t('home.update.download')}
            accessibilityLabel={t('home.update.downloadLabel', { version: update.version })}
            onPress={() => void Linking.openURL(update.url).catch(() => undefined)}
          />
        </Card>
      ) : null}
      {instances.length === 0 ? (
        <EmptyState
          icon={<HardDrives size={22} color={colors.mutedForeground} />}
          title={t('home.empty')}
          description={t('home.emptyHint')}
        />
      ) : (
        instances.map((instance) => (
          <Card key={instance.origin} onPress={() => onOpen(instance.origin)}>
            <Row>
              <InstanceIcon name={instance.name} iconUrl={instance.iconUrl} />
              <View style={styles.grow}>
                <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
                  {instance.name}
                </Text>
                {instance.name !== hostOf(instance.origin) ? (
                  <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {hostOf(instance.origin)}
                  </Text>
                ) : null}
                <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
                  {instance.user
                    ? t('home.signedInAs', { name: instance.user.displayName })
                    : t('home.signedOut')}
                </Text>
              </View>
              {instance.origin === current ? (
                <View style={[styles.dot, { backgroundColor: colors.primary }]} />
              ) : null}
            </Row>
          </Card>
        ))
      )}
      <Button label={t('home.add')} onPress={onAdd} />
      {canJoin ? (
        <Button
          label={t('mobile.join.entry')}
          variant="outline"
          icon={<Hash size={18} color={colors.foreground} />}
          onPress={() => setJoining(true)}
        />
      ) : null}
      <JoinRoomSheet
        open={joining}
        onClose={() => setJoining(false)}
        onScan={onScan}
        onJoined={onJoinedRoom}
      />
      <Separator />
      <View style={styles.soundRow}>
        <Text style={[styles.name, { color: colors.foreground }]}>{t('sounds.label')}</Text>
        <Toggle
          label={t('sounds.label')}
          value={!settings.muted}
          onValueChange={(on) => noticeSettings.update({ muted: !on })}
        />
      </View>
      <Pressable accessibilityRole="text" onPress={() => setTaps((n) => n + 1)}>
        <Text style={[styles.meta, styles.version, { color: colors.mutedForeground }]}>
          {t('voice.debug.version', { version: Constants.expoConfig?.version ?? '' })}
        </Text>
      </Pressable>
      {taps >= 5 ? (
        <Button label={t('voice.debug.open')} variant="outline" onPress={onVoiceDebug} />
      ) : null}
    </Screen>
  );
}

const ICON = 'icon';
const styles = StyleSheet.create({
  grow: { flex: 1, gap: 2 },
  soundRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  name: { fontFamily: font.medium, fontSize: 16 },
  meta: { fontFamily: font.regular, fontSize: 13 },
  version: { textAlign: 'center', paddingVertical: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
