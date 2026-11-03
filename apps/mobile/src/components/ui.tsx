// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { CaretLeft } from 'phosphor-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { font, radius, useTheme } from '../theme.ts';

// The few building blocks of the screens, on the hfps tokens: a tinted background, content on
// raised cards, olive primary buttons, Inter.

export function Screen({
  title,
  subtitle,
  onBack,
  backLabel,
  children,
  scroll = true,
  refreshing,
  onRefresh,
}: {
  title: string;
  /** Under the title, small: the server's address, the space's name. */
  subtitle?: string | undefined;
  onBack?: () => void;
  backLabel?: string;
  children: ReactNode;
  scroll?: boolean;
  /** Pull to refresh (with `scroll`). */
  refreshing?: boolean | undefined;
  onRefresh?: (() => void) | undefined;
}) {
  const { colors } = useTheme();
  const body = <View style={styles.body}>{children}</View>;
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        {onBack ? (
          <Pressable accessibilityRole="button" onPress={onBack} hitSlop={12}>
            <View style={styles.backRow}>
              <CaretLeft size={18} color={colors.primary} />
              <Text style={[styles.back, { color: colors.primary }]}>{backLabel}</Text>
            </View>
          </Pressable>
        ) : null}
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: colors.foreground }]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={refreshing ?? false}
                onRefresh={onRefresh}
                tintColor={colors.primary}
                colors={[colors.primary]}
                progressBackgroundColor={colors.card}
              />
            ) : undefined
          }
        >
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </SafeAreaView>
  );
}

export function Card({ children, onPress }: { children: ReactNode; onPress?: () => void }) {
  const { colors } = useTheme();
  const style = [styles.card, { backgroundColor: colors.card, borderColor: colors.border }];
  if (!onPress) return <View style={style}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [style, pressed && { opacity: 0.7 }]}
    >
      {children}
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  busy = false,
  disabled = false,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'outline' | 'destructive';
  busy?: boolean;
  disabled?: boolean;
  /** 36 px high, for a button beside other content. */
  compact?: boolean;
}) {
  const { colors } = useTheme();
  const filled = variant === 'primary';
  const textColor = filled
    ? colors.primaryForeground
    : variant === 'destructive'
      ? colors.destructive
      : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        filled
          ? { backgroundColor: colors.primary, borderColor: colors.primary }
          : { backgroundColor: colors.card, borderColor: colors.border },
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      {busy ? <ActivityIndicator color={textColor} /> : null}
      <Text style={[styles.buttonText, { color: textColor }]}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, ...input }: { label: string } & TextInputProps) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.mutedForeground}
        {...input}
        onFocus={(e) => {
          setFocused(true);
          input.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          input.onBlur?.(e);
        }}
        style={[
          styles.input,
          {
            color: colors.foreground,
            backgroundColor: colors.card,
            borderColor: focused ? colors.primary : colors.border,
          },
        ]}
      />
    </View>
  );
}

export function Body({
  children,
  muted = false,
  tone,
}: {
  children: ReactNode;
  muted?: boolean;
  tone?: 'destructive' | 'warning' | undefined;
}) {
  const { colors } = useTheme();
  const color = tone ? colors[tone] : muted ? colors.mutedForeground : colors.foreground;
  return <Text style={[styles.text, { color }]}>{children}</Text>;
}

export function Heading({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <Text style={[styles.heading, { color: colors.foreground }]}>{children}</Text>;
}

/** The instance's icon, or its first letter while there is none (or it fails to load). */
export function InstanceIcon({ name, iconUrl }: { name: string; iconUrl?: string | undefined }) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);
  if (iconUrl && !failed) {
    return (
      <Image
        source={{ uri: iconUrl }}
        style={styles.icon}
        onError={() => setFailed(true)}
        accessibilityIgnoresInvertColors
      />
    );
  }
  return (
    <View style={[styles.icon, { backgroundColor: colors.primary }]}>
      <Text style={[styles.iconLetter, { color: colors.primaryForeground }]}>
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

/** A small pill with a count or a word: unread messages, "Live". */
export function Badge({
  label,
  tone = 'primary',
}: {
  label: string;
  tone?: 'primary' | 'muted' | 'destructive';
}) {
  const { colors } = useTheme();
  const background =
    tone === 'primary'
      ? colors.primary
      : tone === 'destructive'
        ? colors.destructive
        : colors.muted;
  const color = tone === 'muted' ? colors.mutedForeground : colors.primaryForeground;
  return (
    <View style={[styles.badge, { backgroundColor: background }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

/** A person's photo, or the first letter of their name on an olive disc. */
export function Avatar({
  name,
  url,
  size = 32,
  ring = false,
}: {
  name: string;
  url?: string | null | undefined;
  size?: number;
  /** The speaking ring (the web's VoiceAvatar): an olive circle around the photo. */
  ring?: boolean;
}) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size, borderRadius: size / 2 };
  const face =
    url && !failed ? (
      <Image
        source={{ uri: url }}
        style={box}
        onError={() => setFailed(true)}
        accessibilityIgnoresInvertColors
      />
    ) : (
      <View style={[box, styles.avatar, { backgroundColor: colors.muted }]}>
        <Text
          style={[styles.avatarLetter, { color: colors.mutedForeground, fontSize: size * 0.42 }]}
        >
          {name.trim().slice(0, 1).toUpperCase()}
        </Text>
      </View>
    );
  if (!ring) return face;
  const outer = size + 8;
  return (
    <View
      style={{
        width: outer,
        height: outer,
        borderRadius: outer / 2,
        borderWidth: 2,
        borderColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {face}
    </View>
  );
}

/** A section label above a group (the web's eyebrow: the only small uppercase text). */
export function SectionLabel({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text accessibilityRole="header" style={[styles.eyebrow, { color: colors.mutedForeground }]}>
      {children}
    </Text>
  );
}

/** The small red dot of something live. */
export function LiveDot() {
  const { colors } = useTheme();
  return <View style={[styles.liveDot, { backgroundColor: colors.destructive }]} />;
}

/** A strip above the content: connection state, a warning. */
export function Banner({
  children,
  tone = 'warning',
}: {
  children: ReactNode;
  tone?: 'warning' | 'destructive' | 'muted';
}) {
  const { colors } = useTheme();
  const color = tone === 'muted' ? colors.mutedForeground : colors[tone];
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.banner, { borderColor: color, backgroundColor: colors.card }]}
    >
      <Text style={[styles.bannerText, { color }]}>{children}</Text>
    </View>
  );
}

/** Nothing here yet: a title and a hint, centred in a card. */
export function Empty({ title, hint }: { title: string; hint?: string | undefined }) {
  return (
    <Card>
      <Heading>{title}</Heading>
      {hint ? <Body muted>{hint}</Body> : null}
    </Card>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, gap: 4 },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  back: { fontFamily: font.medium, fontSize: 15 },
  title: { fontFamily: font.semibold, fontSize: 22 },
  subtitle: { fontFamily: font.regular, fontSize: 13 },
  scroll: { flexGrow: 1 },
  body: { flex: 1, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  card: { borderWidth: 1, borderRadius: radius.card, padding: 12, gap: 8 },
  button: {
    minHeight: 44,
    borderRadius: radius.control,
    borderWidth: 1,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buttonCompact: { minHeight: 36, paddingHorizontal: 14 },
  buttonText: { fontFamily: font.medium, fontSize: 15 },
  field: { gap: 6 },
  label: { fontFamily: font.medium, fontSize: 14 },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    fontFamily: font.regular,
    fontSize: 16,
  },
  text: { fontFamily: font.regular, fontSize: 15, lineHeight: 21 },
  heading: { fontFamily: font.semibold, fontSize: 18 },
  icon: {
    width: 40,
    height: 40,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconLetter: { fontFamily: font.semibold, fontSize: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  eyebrow: {
    fontFamily: font.medium,
    fontSize: 12,
    letterSpacing: 0.96,
    textTransform: 'uppercase',
    marginTop: 6,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  badge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 7,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontFamily: font.semibold, fontSize: 12 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { fontFamily: font.semibold },
  banner: {
    borderWidth: 1,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bannerText: { fontFamily: font.medium, fontSize: 13, lineHeight: 18 },
});
