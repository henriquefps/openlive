// SPDX-License-Identifier: AGPL-3.0-only
import type { Space } from '@openlive/client';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card } from '../../components/ui.tsx';
import { errorText } from '../../i18n/errors.ts';
import { isUnauthenticated } from '../../lib/api.ts';
import { toast } from '../../notices/notify.ts';
import { font, useTheme } from '../../theme.ts';

/** What every section of the space page gets. */
export interface SectionProps {
  origin: string;
  space: Space;
  /** The caller's user id on this server. */
  selfId: string;
}

/** A failed read: the message in the screen's language and a retry. */
export function QueryFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Card>
      <Body tone="destructive">
        {isUnauthenticated(error) ? t('errors.unauthenticated') : errorText(t, error)}
      </Body>
      <Button label={t('common.retry')} variant="outline" onPress={onRetry} />
    </Card>
  );
}

/** The error of a change as a toast (the web's `toast.error(translateError(...))`). */
export function useErrorToast(): (error: unknown) => void {
  const { t } = useTranslation();
  return useCallback((error: unknown) => toast(errorText(t, error), { kind: 'warning' }), [t]);
}

/** A native confirm dialog: the web's AlertDialog. */
export function confirmAction(
  t: TFunction,
  options: {
    title: string;
    message: string;
    action: string;
    destructive?: boolean;
    onConfirm: () => void;
  },
): void {
  Alert.alert(options.title, options.message, [
    { text: t('common.cancel'), style: 'cancel' },
    {
      text: options.action,
      style: options.destructive === false ? 'default' : 'destructive',
      onPress: options.onConfirm,
    },
  ]);
}

/** The time now, read again every `every` ms (countdowns). */
export function useNow(every = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [every]);
  return now;
}

/** A line of small muted text. */
export function Hint({ children }: { children: string }) {
  const { colors } = useTheme();
  return <Text style={[styles.hint, { color: colors.mutedForeground }]}>{children}</Text>;
}

/** A label with an optional hint under a control. */
export function Labeled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.labeled}>
      <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
      {children}
      {hint ? <Hint>{hint}</Hint> : null}
    </View>
  );
}

/** A label and hint at the left, a control (a switch) at the right. */
export function SwitchRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchText}>
        <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
        {hint ? <Hint>{hint}</Hint> : null}
      </View>
      {children}
    </View>
  );
}

export function ErrorLine({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  if (!error) return null;
  return (
    <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: colors.destructive }]}>
      {errorText(t, error)}
    </Text>
  );
}

const styles = StyleSheet.create({
  hint: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
  labeled: { gap: 6 },
  label: { fontFamily: font.medium, fontSize: 14 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchText: { flex: 1, gap: 2 },
});
