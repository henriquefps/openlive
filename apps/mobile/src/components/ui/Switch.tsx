// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';
import {
  SWITCH_HEIGHT,
  SWITCH_INSET,
  SWITCH_THUMB,
  SWITCH_WIDTH,
  thumbOffset,
  toggleColors,
} from '../../lib/toggle-colors.ts';
import { useTheme } from '../../theme.ts';

/**
 * A switch drawn in the theme colors. The platform one tints its thumb with the Android accent
 * (teal) whatever thumbColor is, so this is drawn by hand.
 */
export function Switch({
  value,
  onValueChange,
  label,
  disabled = false,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const c = toggleColors(colors, value);
  const [x] = useState(() => new Animated.Value(thumbOffset(value)));

  useEffect(() => {
    Animated.timing(x, {
      toValue: thumbOffset(value),
      duration: 150,
      useNativeDriver: true,
    }).start();
  }, [value, x]);

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => onValueChange(!value)}
      style={[
        styles.track,
        {
          backgroundColor: value ? c.trackOn : c.trackOff,
          borderColor: value ? c.trackOn : colors.border,
        },
        disabled && styles.disabled,
      ]}
    >
      <Animated.View
        style={[styles.thumb, { backgroundColor: c.thumb, transform: [{ translateX: x }] }]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: SWITCH_WIDTH,
    height: SWITCH_HEIGHT,
    borderRadius: SWITCH_HEIGHT / 2,
    borderWidth: 2,
    justifyContent: 'center',
    paddingLeft: SWITCH_INSET,
  },
  thumb: {
    width: SWITCH_THUMB,
    height: SWITCH_THUMB,
    borderRadius: SWITCH_THUMB / 2,
  },
  disabled: { opacity: 0.5 },
});
