// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { font, radius, useTheme } from '../../theme.ts';

const SLIDE = 'slide';
const BOTTOM = ['bottom'] as const;

/** A bottom sheet over the screen: a title, content, a tap outside or Back closes it. */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <Modal transparent animationType={SLIDE} onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" />
      <SafeAreaView
        edges={BOTTOM}
        style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.content}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>
            {title}
          </Text>
          {children}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: radius.card + 4,
    borderTopRightRadius: radius.card + 4,
    borderWidth: 1,
    borderBottomWidth: 0,
  },
  content: { padding: 16, gap: 12 },
  title: { fontFamily: font.semibold, fontSize: 18 },
});
