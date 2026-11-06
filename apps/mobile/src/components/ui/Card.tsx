// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { radius, useTheme } from '../../theme.ts';

/**
 * The web's Card: radius 12, a hairline border, lighter than the background in dark. With
 * `onPress` the whole card is a button.
 */
export function Card({
  children,
  onPress,
  padded = true,
}: {
  children: ReactNode;
  onPress?: () => void;
  /** False for a card whose children bring their own padding (a list of rows). */
  padded?: boolean;
}) {
  const { colors } = useTheme();
  const style = [
    styles.card,
    padded && styles.padded,
    { backgroundColor: colors.card, borderColor: colors.border },
  ];
  if (!onPress) return <View style={style}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [style, pressed && { backgroundColor: colors.muted }]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.card, overflow: 'hidden' },
  padded: { padding: 14, gap: 8 },
});
