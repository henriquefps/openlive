// SPDX-License-Identifier: AGPL-3.0-only
import { CaretDown, Check } from 'phosphor-react-native';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  badgeText,
  resolveSection,
  type Section,
  sectionPresentation,
} from '../../lib/section-select.ts';
import { font, radius, useTheme } from '../../theme.ts';
import { Badge } from './Badge.tsx';

const SLIDE = 'slide';
const BOTTOM = ['bottom'] as const;

/**
 * The phone's SpaceSectionSwitcher: the sections of a page, one shown at a time. Two or three
 * sections are a segmented control; more are a full-width select that opens a bottom sheet.
 * A section can carry a badge (unread, pending).
 */
export function SectionSelect<T extends string>({
  sections,
  value,
  onChange,
  title,
  dot = false,
}: {
  sections: readonly Section<T>[];
  value: T | string | undefined;
  onChange: (next: T) => void;
  /** The sheet's title and the select's accessibility label. */
  title: string;
  /** A small dot on the select's trigger: something waits in a section that is not on screen. */
  dot?: boolean;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const selected = resolveSection(sections, value);
  if (!selected) return null;

  if (sectionPresentation(sections.length) === 'segmented') {
    return (
      <View
        accessibilityRole="tablist"
        style={[styles.segmented, { backgroundColor: colors.muted }]}
      >
        {sections.map((section) => {
          const active = section.value === selected.value;
          const badge = badgeText(section.badge);
          return (
            <Pressable
              key={section.value}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => onChange(section.value)}
              style={[
                styles.segment,
                active && { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text
                style={[
                  styles.segmentText,
                  { color: active ? colors.foreground : colors.mutedForeground },
                ]}
                numberOfLines={1}
              >
                {section.label}
              </Text>
              {badge ? <Badge label={badge} tone={active ? 'primary' : 'secondary'} /> : null}
            </Pressable>
          );
        })}
      </View>
    );
  }

  const selectedBadge = badgeText(selected.badge);
  return (
    <>
      <Pressable
        accessibilityRole="combobox"
        accessibilityLabel={title}
        accessibilityValue={{ text: selected.label }}
        onPress={() => setOpen(true)}
        style={[styles.trigger, { backgroundColor: colors.card, borderColor: colors.input }]}
      >
        <Text style={[styles.triggerText, { color: colors.foreground }]} numberOfLines={1}>
          {selected.label}
        </Text>
        {selectedBadge ? <Badge label={selectedBadge} /> : null}
        <CaretDown size={16} color={colors.mutedForeground} />
        {dot ? (
          <View
            testID="section-pending-dot"
            style={[styles.dot, { backgroundColor: colors.primary }]}
          />
        ) : null}
      </Pressable>
      {open ? (
        <Modal transparent animationType={SLIDE} onRequestClose={() => setOpen(false)}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setOpen(false)}
            accessibilityRole="button"
          />
          <SafeAreaView
            edges={BOTTOM}
            style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Text
              accessibilityRole="header"
              style={[styles.sheetTitle, { color: colors.foreground }]}
            >
              {title}
            </Text>
            <ScrollView>
              {sections.map((section) => {
                const active = section.value === selected.value;
                const badge = badgeText(section.badge);
                return (
                  <Pressable
                    key={section.value}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      setOpen(false);
                      onChange(section.value);
                    }}
                    style={({ pressed }) => [
                      styles.option,
                      pressed && { backgroundColor: colors.muted },
                    ]}
                  >
                    <Text
                      style={[
                        styles.optionText,
                        {
                          color: colors.foreground,
                          fontFamily: active ? font.semibold : font.regular,
                        },
                      ]}
                      numberOfLines={1}
                    >
                      {section.label}
                    </Text>
                    {badge ? <Badge label={badge} tone="secondary" /> : null}
                    {active ? <Check size={18} color={colors.primary} weight="bold" /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </SafeAreaView>
        </Modal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  segmented: { flexDirection: 'row', borderRadius: radius.control + 2, padding: 3, gap: 2 },
  segment: {
    flex: 1,
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: 'transparent',
    paddingHorizontal: 8,
  },
  segmentText: { fontFamily: font.medium, fontSize: 14, flexShrink: 1 },
  trigger: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'stretch',
  },
  dot: { position: 'absolute', top: 4, right: 4, width: 8, height: 8, borderRadius: 4 },
  triggerText: { flex: 1, fontFamily: font.medium, fontSize: 15 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: radius.card + 4,
    borderTopRightRadius: radius.card + 4,
    borderWidth: 1,
    borderBottomWidth: 0,
    maxHeight: '70%',
    paddingTop: 16,
  },
  sheetTitle: { fontFamily: font.semibold, fontSize: 18, paddingHorizontal: 16, paddingBottom: 8 },
  option: {
    minHeight: 48,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  optionText: { flex: 1, fontSize: 16 },
});
