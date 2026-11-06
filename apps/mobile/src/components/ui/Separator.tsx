// SPDX-License-Identifier: AGPL-3.0-only
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme.ts';

/** A hairline, horizontal by default. */
export function Separator({ vertical = false }: { vertical?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="none"
      style={[vertical ? styles.vertical : styles.horizontal, { backgroundColor: colors.border }]}
    />
  );
}

const styles = StyleSheet.create({
  horizontal: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  vertical: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
});
