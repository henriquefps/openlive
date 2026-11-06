// SPDX-License-Identifier: AGPL-3.0-only
import type { JoinByCodeResult } from '@openlive/client';
import { QrCode } from 'phosphor-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { JoinForm } from '../components/JoinForm.tsx';
import { Button } from '../components/ui.tsx';
import { Sheet } from '../components/ui/index.ts';
import { font, useTheme } from '../theme.ts';
import { useInstances } from '../state.tsx';

/**
 * The home screen's way to a quick room by its code (the web's /join): pick the server when
 * several are signed in, type the code, or scan a QR code.
 */
export function JoinRoomSheet({
  open,
  onClose,
  onScan,
  onJoined,
}: {
  open: boolean;
  onClose: () => void;
  onScan: () => void;
  onJoined: (origin: string, joined: JoinByCodeResult) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { instances } = useInstances();
  const signedIn = instances.filter((i) => i.user);
  const [picked, setPicked] = useState<string | null>(null);
  const origin = signedIn.find((i) => i.origin === picked)?.origin ?? signedIn[0]?.origin;

  return (
    <Sheet open={open} onClose={onClose} title={t('join.title')} description={t('join.intro')}>
      {origin === undefined ? (
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
          {t('mobile.join.noServer')}
        </Text>
      ) : (
        <>
          {signedIn.length > 1 ? (
            <View style={styles.servers}>
              <Text style={[styles.label, { color: colors.foreground }]}>
                {t('mobile.join.server')}
              </Text>
              {signedIn.map((i) => (
                <Button
                  key={i.origin}
                  label={i.name}
                  variant={i.origin === origin ? 'default' : 'outline'}
                  onPress={() => setPicked(i.origin)}
                />
              ))}
            </View>
          ) : null}
          <JoinForm
            key={origin}
            origin={origin}
            onRoom={(joined) => {
              onClose();
              onJoined(origin, joined);
            }}
          />
        </>
      )}
      <Button
        label={t('add.scan')}
        variant="outline"
        icon={<QrCode size={18} color={colors.foreground} />}
        onPress={() => {
          onClose();
          onScan();
        }}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  servers: { gap: 8 },
  label: { fontFamily: font.medium, fontSize: 14 },
  hint: { fontFamily: font.regular, fontSize: 14, lineHeight: 20 },
});
