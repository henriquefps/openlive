// SPDX-License-Identifier: AGPL-3.0-only
import { type BarcodeSettings, CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Body, Button, Screen } from '../components/ui.tsx';
import { type AppLink, parseScanned } from '../lib/deeplink.ts';
import { radius } from '../theme.ts';

const QR_ONLY: BarcodeSettings = { barcodeTypes: ['qr'] };

/** Reads the QR code of an instance address or an invite. */
export function ScanScreen({
  onBack,
  onResult,
}: {
  onBack: () => void;
  onResult: (link: Extract<AppLink, { kind: 'join' }>) => void;
}) {
  const { t } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  const [unknown, setUnknown] = useState(false);
  const done = useRef(false);

  return (
    <Screen title={t('scan.title')} onBack={onBack} backLabel={t('add.title')} scroll={false}>
      {permission?.granted ? (
        <>
          <Body muted>{t('scan.hint')}</Body>
          <View style={styles.frame}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={QR_ONLY}
              onBarcodeScanned={({ data }) => {
                if (done.current) return;
                const link = parseScanned(data);
                if (link.kind === 'join') {
                  done.current = true;
                  onResult(link);
                } else {
                  setUnknown(true);
                }
              }}
            />
          </View>
          {unknown ? <Body tone="destructive">{t('scan.unknown')}</Body> : null}
        </>
      ) : (
        <>
          <Body>{t('scan.permission')}</Body>
          <Button label={t('scan.grant')} onPress={() => void requestPermission()} />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, maxHeight: 420, borderRadius: radius.card, overflow: 'hidden' },
});
