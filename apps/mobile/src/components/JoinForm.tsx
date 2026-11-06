// SPDX-License-Identifier: AGPL-3.0-only
import type { JoinByCodeResult } from '@openlive/client';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text } from 'react-native';
import { useJoinByCode } from '../account-queries.ts';
import { errorText } from '../i18n/errors.ts';
import { hostOf } from '../lib/host.ts';
import { parseJoinInput } from '../lib/join-input.ts';
import { font, useTheme } from '../theme.ts';
import { Button, Field } from './ui.tsx';

/** The code format, the same in every language. */
const CODE_EXAMPLE = 'OL-1234-5678';

/**
 * "Join with code" (the web's JoinCodeForm and JoinPage): type or paste a quick room's code, its
 * /join link, or an invite link or token. A code joins at once; an invite goes to `onInvite`.
 */
export function JoinForm({
  origin,
  onRoom,
  onInvite,
}: {
  origin: string;
  onRoom: (joined: JoinByCodeResult) => void;
  /** Only the spaces list handles invites; without it the form takes room codes only. */
  onInvite?: ((token: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const join = useJoinByCode(origin);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = () => {
    const input = parseJoinInput(text);
    if (input.kind === 'unknown' || (input.kind === 'invite' && !onInvite)) {
      setProblem(t(onInvite ? 'mobile.join.unknown' : 'mobile.join.unknownCode'));
      return;
    }
    if (input.instance && input.instance !== origin) {
      setProblem(t('mobile.join.otherServer', { host: hostOf(input.instance) }));
      return;
    }
    setProblem(null);
    if (input.kind === 'invite') {
      onInvite?.(input.token);
      setText('');
      return;
    }
    join.mutate(input.code, { onSuccess: (joined) => (setText(''), onRoom(joined)) });
  };

  const error = problem ?? (join.error ? errorText(t, join.error) : null);
  return (
    <>
      <Field
        label={onInvite ? t('mobile.join.pasteLabel') : t('join.label')}
        value={text}
        onChangeText={(v) => {
          setText(v);
          setProblem(null);
          if (join.isError) join.reset();
        }}
        placeholder={CODE_EXAMPLE}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        invalid={error !== null}
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <Text style={[styles.hint, { color: colors.mutedForeground }]}>
        {onInvite ? t('mobile.join.hint') : t('join.hint')}
      </Text>
      {error ? <Text style={[styles.hint, { color: colors.destructive }]}>{error}</Text> : null}
      <Button
        label={t('join.submit')}
        disabled={!text.trim()}
        busy={join.isPending}
        onPress={submit}
      />
    </>
  );
}

const styles = StyleSheet.create({
  hint: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
});
