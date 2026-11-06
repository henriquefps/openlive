// SPDX-License-Identifier: AGPL-3.0-only
import { CaretLeft } from 'phosphor-react-native';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { font, useTheme } from '../../theme.ts';
import { Skeleton } from './Skeleton.tsx';

/**
 * The web's Page header on a phone: a compact breadcrumb line ("‹ Parent") that is the back
 * control, then the title, a description and the page's actions. The back goes to the PARENT
 * level of the page (the screen below it in the navigation stack), named by `parentLabel`.
 * A title that is still loading passes `title={undefined}` and shows a skeleton.
 */
export function PageHeader({
  title,
  description,
  actions,
  onBack,
  parentLabel,
  backAccessibilityLabel,
}: {
  title: string | undefined;
  description?: string | undefined;
  /** At the right of the title: buttons of the page (settings, profile). */
  actions?: ReactNode;
  /** Absent on the top level (the server list). */
  onBack?: (() => void) | undefined;
  /** The name of the parent level, shown after the caret. */
  parentLabel?: string | undefined;
  /** What a screen reader says for the back control; defaults to the parent's name. */
  backAccessibilityLabel?: string | undefined;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={backAccessibilityLabel ?? parentLabel}
          onPress={onBack}
          hitSlop={{ top: 8, bottom: 8, left: 12, right: 24 }}
          style={styles.crumb}
        >
          <CaretLeft size={14} color={colors.mutedForeground} />
          <Text style={[styles.crumbText, { color: colors.mutedForeground }]} numberOfLines={1}>
            {parentLabel}
          </Text>
        </Pressable>
      ) : null}
      <View style={styles.titleRow}>
        <View style={styles.titleText}>
          {title === undefined ? (
            <Skeleton width={160} height={22} />
          ) : (
            <Text
              accessibilityRole="header"
              style={[styles.title, { color: colors.foreground }]}
              numberOfLines={1}
            >
              {title}
            </Text>
          )}
          {description ? (
            <Text style={[styles.description, { color: colors.mutedForeground }]} numberOfLines={2}>
              {description}
            </Text>
          ) : null}
        </View>
        {actions ? <View style={styles.actions}>{actions}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  crumb: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start' },
  crumbText: { fontFamily: font.medium, fontSize: 13, flexShrink: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  titleText: { flex: 1, gap: 2 },
  title: { fontFamily: font.semibold, fontSize: 20 },
  description: { fontFamily: font.regular, fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
