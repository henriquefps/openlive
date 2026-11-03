// SPDX-License-Identifier: AGPL-3.0-only
import { Bell, WarningCircle } from 'phosphor-react-native';
import { useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { font, radius, useTheme } from '../theme.ts';
import { type Toast, toasts } from './toasts.ts';

const PASS_THROUGH = 'box-none';

/**
 * The toasts, over the screen at the top: small, never blocking (the touches outside them go to
 * the app), each leaves by itself and a tap closes it (after doing what it leads to).
 */
export function ToastHost() {
  const list = useSyncExternalStore(toasts.subscribe, toasts.getState);
  const insets = useSafeAreaInsets();
  if (list.length === 0) return null;
  return (
    <View pointerEvents={PASS_THROUGH} style={[styles.host, { top: insets.top + 8 }]}>
      {list.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </View>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const { colors } = useTheme();
  const tone = toast.kind === 'warning' ? colors.warning : colors.primary;
  const Icon = toast.kind === 'warning' ? WarningCircle : Bell;
  const press = () => {
    toast.onPress?.();
    toasts.dismiss(toast.id);
  };
  return (
    <Pressable
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      onPress={press}
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <Icon size={20} color={tone} weight="fill" />
      <View style={styles.text}>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={2}>
          {toast.title}
        </Text>
        {toast.description ? (
          <Text style={[styles.description, { color: colors.mutedForeground }]} numberOfLines={1}>
            {toast.description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 12, right: 12, gap: 6, zIndex: 1000, elevation: 1000 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  text: { flex: 1, gap: 1 },
  title: { fontFamily: font.medium, fontSize: 14 },
  description: { fontFamily: font.regular, fontSize: 12 },
});
