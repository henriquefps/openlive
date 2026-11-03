// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { type GestureResponderEvent, StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme.ts';
import { sliderValue } from '../slider.ts';

const NONE = 'none';
const INCREMENT = 'increment';
const DECREMENT = 'decrement';
const ACTIONS = [{ name: INCREMENT }, { name: DECREMENT }];

/** A horizontal slider: touch or drag on the track. React Native has none of its own. */
export function VolumeSlider({
  value,
  max,
  step,
  label,
  onChange,
}: {
  value: number;
  max: number;
  step: number;
  label: string;
  onChange: (value: number) => void;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const at = (e: GestureResponderEvent) =>
    onChange(sliderValue(e.nativeEvent.locationX, width, max, step));
  const fill = width * Math.min(1, value / max);
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max, now: value }}
      accessibilityActions={ACTIONS}
      onAccessibilityAction={(e) => {
        const next = value + (e.nativeEvent.actionName === INCREMENT ? step : -step);
        onChange(Math.min(max, Math.max(0, next)));
      }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={at}
      onResponderMove={at}
      style={styles.hit}
    >
      <View style={[styles.track, { backgroundColor: colors.muted }]} pointerEvents={NONE}>
        <View style={[styles.fill, { width: fill, backgroundColor: colors.primary }]} />
      </View>
      <View
        pointerEvents={NONE}
        style={[
          styles.thumb,
          {
            left: Math.max(0, fill - 11),
            backgroundColor: colors.primary,
            borderColor: colors.card,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hit: { height: 44, justifyContent: 'center' },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6 },
  thumb: { position: 'absolute', width: 22, height: 22, borderRadius: 11, borderWidth: 2 },
});
