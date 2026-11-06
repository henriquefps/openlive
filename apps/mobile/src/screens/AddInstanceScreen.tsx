// SPDX-License-Identifier: AGPL-3.0-only
import type { InstanceInfo } from '@openlive/protocol';
import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import {
  Body,
  Button,
  Card,
  Field,
  Heading,
  InstanceIcon,
  Row,
  Screen,
} from '../components/ui.tsx';
import { errorText } from '../i18n/errors.ts';
import { fetchInstanceInfo } from '../lib/api.ts';
import { checkCompatibility, type Compatibility, normalizeInstanceUrl } from '../lib/instance.ts';
import { useInstances } from '../state.tsx';

type Check =
  | { step: 'idle' }
  | { step: 'checking' }
  | { step: 'error'; message: string }
  | { step: 'found'; origin: string; info: InstanceInfo; compat: Compatibility };

/** Reads the instance's well-known document and whether this app can use it. */
async function inspect(input: string, t: TFunction): Promise<Check> {
  const origin = normalizeInstanceUrl(input);
  if (!origin) return { step: 'error', message: t('add.invalidUrl') };
  try {
    const info = await fetchInstanceInfo(origin);
    return { step: 'found', origin, info, compat: checkCompatibility(info) };
  } catch (error) {
    return { step: 'error', message: errorText(t, error) };
  }
}

/**
 * "What is the address of your Openlive?": typed, scanned or handed over by a link. The app reads
 * /.well-known/openlive.json and shows the instance before anyone signs in.
 */
export function AddInstanceScreen({
  initialOrigin,
  onBack,
  onScan,
  onReady,
}: {
  initialOrigin?: string | undefined;
  onBack: () => void;
  onScan: () => void;
  /** The instance is on the list (and signed in, when the login went through). */
  onReady: (origin: string, info: InstanceInfo) => void;
}) {
  const { t } = useTranslation();
  const { instances, add, signIn } = useInstances();
  const [text, setText] = useState(initialOrigin ?? '');
  const [check, setCheck] = useState<Check>(
    initialOrigin ? { step: 'checking' } : { step: 'idle' },
  );
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const run = (input: string) => {
    setCheck({ step: 'checking' });
    void inspect(input, t).then(setCheck);
  };

  useEffect(() => {
    if (!initialOrigin) return;
    let live = true;
    void inspect(initialOrigin, t).then((next) => {
      if (live) setCheck(next);
    });
    return () => {
      live = false;
    };
  }, [initialOrigin, t]);

  const known = check.step === 'found' && instances.some((i) => i.origin === check.origin);

  const addAndSignIn = async (origin: string, info: InstanceInfo) => {
    setBusy(true);
    setLoginError(null);
    try {
      await add(origin, info);
      const outcome = await signIn(origin);
      if (outcome.ok) {
        onReady(origin, info);
        return;
      }
      setLoginError(
        outcome.reason === 'error' ? errorText(t, outcome.code) : t(`login.${outcome.reason}`),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('add.title')} onBack={onBack} backLabel={t('home.title')}>
      <Body>{t('add.prompt')}</Body>
      <Field
        label={t('add.urlLabel')}
        placeholder={t('add.urlPlaceholder')}
        value={text}
        onChangeText={setText}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        inputMode="url"
        returnKeyType="go"
        onSubmitEditing={() => run(text)}
      />
      <Button
        label={t('add.continue')}
        onPress={() => run(text)}
        busy={check.step === 'checking'}
        disabled={text.trim() === ''}
      />
      <Button label={t('add.scan')} variant="outline" onPress={onScan} />
      {check.step === 'checking' ? <Body muted>{t('add.checking')}</Body> : null}
      {check.step === 'error' ? <Body tone="destructive">{check.message}</Body> : null}
      {check.step === 'found' ? (
        <Card>
          <Row>
            <InstanceIcon name={check.info.name} iconUrl={check.info.iconUrl} />
            <View style={{ flex: 1 }}>
              <Heading>{check.info.name}</Heading>
              <Body muted>{t('add.version', { version: check.info.version })}</Body>
            </View>
          </Row>
          {check.compat.ok ? (
            known ? (
              <>
                <Body muted>{t('add.alreadyAdded')}</Body>
                <Button label={t('add.open')} onPress={() => onReady(check.origin, check.info)} />
              </>
            ) : (
              <Button
                label={t('add.signIn')}
                busy={busy}
                onPress={() => void addAndSignIn(check.origin, check.info)}
              />
            )
          ) : (
            <Body tone="warning">{t(`compat.${check.compat.reason}`)}</Body>
          )}
          {loginError ? <Body tone="destructive">{loginError}</Body> : null}
        </Card>
      ) : null}
    </Screen>
  );
}
