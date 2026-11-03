// SPDX-License-Identifier: AGPL-3.0-only
import Constants from 'expo-constants';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, Heading, InstanceIcon, Row, Screen } from '../components/ui.tsx';
import { hostOf } from '../lib/host.ts';
import { useInstances } from '../state.tsx';
import { font, useTheme } from '../theme.ts';

/** The instances on this phone, like the accounts of a Mastodon app: tap one to switch to it. */
export function HomeScreen({
  current,
  onOpen,
  onAdd,
  onVoiceDebug,
}: {
  current: string | null;
  onOpen: (origin: string) => void;
  onAdd: () => void;
  onVoiceDebug: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { instances } = useInstances();
  // Tapping the version five times shows the voice test: a debug screen, not for everyday use.
  const [taps, setTaps] = useState(0);
  return (
    <Screen title={t('home.title')}>
      {instances.length === 0 ? (
        <Card>
          <Heading>{t('home.empty')}</Heading>
          <Body muted>{t('home.emptyHint')}</Body>
        </Card>
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

const styles = StyleSheet.create({
  grow: { flex: 1, gap: 2 },
  name: { fontFamily: font.medium, fontSize: 16 },
  meta: { fontFamily: font.regular, fontSize: 13 },
  version: { textAlign: 'center', paddingVertical: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
