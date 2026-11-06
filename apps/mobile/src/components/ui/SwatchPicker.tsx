// SPDX-License-Identifier: AGPL-3.0-only
import { Check } from 'phosphor-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { font, radius, useTheme } from '../../theme.ts';

/** One choice with a color to preview (a palette): a swatch, its name, the selected one ringed. */
export function SwatchPicker<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string; color: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="radiogroup" style={styles.wrap}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            style={[
              styles.option,
              {
                backgroundColor: colors.card,
                borderColor: selected ? colors.primary : colors.border,
              },
            ]}
          >
            <View style={[styles.swatch, { backgroundColor: option.color }]}>
              {selected ? <Check size={12} weight="bold" color={CHECK} /> : null}
            </View>
            <Text style={[styles.label, { color: colors.foreground }]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const CHECK = '#ffffff';
const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  option: {
    minHeight: 36,
    paddingHorizontal: 10,
    borderRadius: radius.control,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontFamily: font.medium, fontSize: 14 },
});
