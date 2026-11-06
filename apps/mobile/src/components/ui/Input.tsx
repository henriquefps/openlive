// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { StyleSheet, Text, TextInput, type TextInputProps, View } from 'react-native';
import { font, radius, useTheme } from '../../theme.ts';

/** The web's Input: 44 px high, hairline border, the ring color while focused. */
export function Input(props: TextInputProps & { invalid?: boolean }) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const { invalid, style, onFocus, onBlur, ...rest } = props;
  return (
    <TextInput
      placeholderTextColor={colors.mutedForeground}
      selectionColor={colors.primary}
      {...rest}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      style={[
        styles.input,
        {
          color: colors.foreground,
          backgroundColor: colors.card,
          borderColor: invalid ? colors.destructive : focused ? colors.ring : colors.input,
        },
        focused && styles.focused,
        style,
      ]}
    />
  );
}

/** An Input with its label above (the web's Field). */
export function Field({
  label,
  invalid,
  ...input
}: { label: string; invalid?: boolean } & TextInputProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
      <Input accessibilityLabel={label} invalid={invalid ?? false} {...input} />
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    fontFamily: font.regular,
    fontSize: 16,
  },
  focused: { borderWidth: 1.5 },
  field: { gap: 6 },
  label: { fontFamily: font.medium, fontSize: 14 },
});
