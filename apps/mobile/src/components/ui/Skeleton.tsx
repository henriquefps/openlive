// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Animated, type DimensionValue, StyleSheet } from 'react-native';
import { radius, useTheme } from '../../theme.ts';

/** A pulsing placeholder for something that is loading (the web's Skeleton). */
export function Skeleton({
  width = '100%',
  height = 16,
  rounded = radius.control,
}: {
  width?: DimensionValue;
  height?: number;
  rounded?: number;
}) {
  const { colors } = useTheme();
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.5, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility={HIDE}
      style={[
        styles.skeleton,
        { width, height, borderRadius: rounded, backgroundColor: colors.muted, opacity },
      ]}
    />
  );
}

const HIDE = 'no-hide-descendants';
const styles = StyleSheet.create({ skeleton: { alignSelf: 'flex-start' } });
