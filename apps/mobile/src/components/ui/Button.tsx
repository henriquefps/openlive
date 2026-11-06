// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { withAlpha } from '../../lib/color.ts';
import { font, radius, useTheme } from '../../theme.ts';

export type ButtonVariant = 'default' | 'outline' | 'ghost' | 'destructive';
/** `sm` is 36 px, `default` 44 px (a touch target), `icon` a 44 px square for an icon alone. */
export type ButtonSize = 'default' | 'sm' | 'icon';

/** The web's Button: filled primary, outline, ghost, and a tinted destructive. */
export function Button({
  label,
  onPress,
  variant = 'default',
  size = 'default',
  compact = false,
  icon,
  busy = false,
  disabled = false,
  accessibilityLabel,
}: {
  /** Text of the button; for `size="icon"` it is the accessibility label. */
  label: string;
  onPress: () => void;
  variant?: ButtonVariant | 'primary';
  size?: ButtonSize;
  /** The previous name of `size="sm"`. */
  compact?: boolean;
  /** An icon (Phosphor) before the label. */
  icon?: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors, dark } = useTheme();
  const kind: ButtonVariant = variant === 'primary' ? 'default' : variant;
  const small = compact || size === 'sm';
  const color =
    kind === 'default'
      ? colors.primaryForeground
      : kind === 'destructive'
        ? colors.destructive
        : colors.foreground;
  const surface =
    kind === 'default'
      ? { backgroundColor: colors.primary, borderColor: colors.primary }
      : kind === 'outline'
        ? { backgroundColor: dark ? colors.input : colors.background, borderColor: colors.border }
        : kind === 'destructive'
          ? {
              backgroundColor: withAlpha(colors.destructive, dark ? 0.2 : 0.1),
              borderColor: 'transparent',
            }
          : { backgroundColor: 'transparent', borderColor: 'transparent' };
  const hover =
    kind === 'ghost' || kind === 'outline' ? { backgroundColor: colors.muted } : undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        small && styles.small,
        size === 'icon' && styles.icon,
        surface,
        kind === 'outline' && !dark && styles.shadowXs,
        pressed && hover,
        pressed && kind === 'default' && { opacity: 0.8 },
        disabled && { opacity: 0.5 },
      ]}
    >
      {busy ? <ActivityIndicator color={color} /> : icon ? <View>{icon}</View> : null}
      {size === 'icon' ? null : (
        <Text style={[styles.text, small && styles.textSmall, { color }]} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    borderRadius: radius.control,
    borderWidth: 1,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  small: { minHeight: 36, paddingHorizontal: 12 },
  icon: { width: 44, paddingHorizontal: 0 },
  // The web's shadow-xs.
  shadowXs: {
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 1,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  text: { fontFamily: font.medium, fontSize: 15 },
  textSmall: { fontSize: 14 },
});
