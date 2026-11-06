// SPDX-License-Identifier: AGPL-3.0-only
import { StyleSheet, Text, View } from 'react-native';
import { withAlpha } from '../../lib/color.ts';
import { font, useTheme } from '../../theme.ts';

export type BadgeTone =
  'primary' | 'secondary' | 'muted' | 'destructive' | 'live' | 'warning' | 'outline';

/** The web's Badge: a small pill with a count or a word (unread, Live). */
export function Badge({ label, tone = 'primary' }: { label: string; tone?: BadgeTone }) {
  const { colors, dark } = useTheme();
  const tint = (c: string) => withAlpha(c, dark ? 0.2 : 0.1);
  const look = {
    primary: { bg: colors.primary, fg: colors.primaryForeground, border: 'transparent' },
    secondary: { bg: colors.secondary, fg: colors.secondaryForeground, border: 'transparent' },
    muted: { bg: colors.muted, fg: colors.mutedForeground, border: 'transparent' },
    destructive: { bg: tint(colors.destructive), fg: colors.destructive, border: 'transparent' },
    live: { bg: colors.live, fg: colors.liveForeground, border: 'transparent' },
    warning: { bg: tint(colors.warning), fg: colors.warning, border: 'transparent' },
    outline: { bg: 'transparent', fg: colors.foreground, border: colors.border },
  }[tone];
  return (
    <View style={[styles.badge, { backgroundColor: look.bg, borderColor: look.border }]}>
      <Text style={[styles.text, { color: look.fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 8,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { fontFamily: font.medium, fontSize: 12 },
});
