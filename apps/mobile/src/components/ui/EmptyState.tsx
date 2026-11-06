// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { font, radius, useTheme } from '../../theme.ts';

/** The web's EmptyState: an icon in a rounded square, a title, a hint and optional actions. */
export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  /** A Phosphor icon element, already colored (see `useTheme().colors.mutedForeground`). */
  icon?: ReactNode;
  title: string;
  description?: string | undefined;
  /** Buttons under the text. */
  children?: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.box, { borderColor: colors.border }]}>
      {icon ? <View style={[styles.media, { backgroundColor: colors.muted }]}>{icon}</View> : null}
      <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>
        {title}
      </Text>
      {description ? (
        <Text style={[styles.description, { color: colors.mutedForeground }]}>{description}</Text>
      ) : null}
      {children ? <View style={styles.actions}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: radius.card,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  media: {
    width: 40,
    height: 40,
    borderRadius: radius.card - 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  title: { fontFamily: font.semibold, fontSize: 17, textAlign: 'center' },
  description: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: 8, marginTop: 8 },
});
