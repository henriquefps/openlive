// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { font, radius, useTheme } from '../../theme.ts';

const SLIDE = 'slide';
const BOTTOM = ['bottom'] as const;

/**
 * The web's ResponsiveDialog on a phone: a card from the bottom with a title, a description and
 * a scrolling body (forms, a created link). Tapping outside or the system back closes it.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string | undefined;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <Modal
      visible={open}
      transparent
      animationType={SLIDE}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        />
        <SafeAreaView
          edges={BOTTOM}
          style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <View style={styles.header}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>
              {title}
            </Text>
            {description ? (
              <Text style={[styles.description, { color: colors.mutedForeground }]}>
                {description}
              </Text>
            ) : null}
          </View>
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: radius.card + 4,
    borderTopRightRadius: radius.card + 4,
    borderWidth: 1,
    borderBottomWidth: 0,
    maxHeight: '90%',
  },
  header: { paddingHorizontal: 16, paddingTop: 16, gap: 4 },
  title: { fontFamily: font.semibold, fontSize: 18 },
  description: { fontFamily: font.regular, fontSize: 14, lineHeight: 20 },
  body: { padding: 16, gap: 16 },
});
