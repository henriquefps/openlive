// SPDX-License-Identifier: AGPL-3.0-only
import { loadPrefs, savePrefs } from '@openlive/client';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, View } from 'react-native';
import {
  Avatar,
  AvatarSourceProvider,
  Body,
  Button,
  Card,
  Field,
  Group,
  Row,
  Screen,
  Segmented,
  SectionLabel,
  SettingRow,
  Toggle,
} from '../components/ui.tsx';
import { errorText } from '../i18n/errors.ts';
import { DISPLAY_NAME_MAX, nameProblem } from '../lib/avatar.ts';
import { LANGUAGES, type LanguageChoice, THEMES, type ThemeChoice } from '../lib/settings.ts';
import { useApi, useAuthHeaders } from '../hooks.ts';
import { CAMERA, choosePhoto, GALLERY, type PhotoSource } from '../photo.ts';
import { useMe, useProfileActions } from '../queries.ts';
import { setLanguage, setTheme, useSettings } from '../settings.ts';
import { useInstances } from '../state.tsx';
import { voicePrefsStore } from '../voice/store.ts';

/**
 * The settings of the app: this phone's language, theme and voice, and, when opened from a
 * server, the profile there (name and photo are per server) and signing out of it.
 */
export function SettingsScreen({
  origin,
  onBack,
  onSignedOut,
}: {
  origin?: string | undefined;
  onBack: () => void;
  /** Called before the sign-out starts, so the screens above the server's go away first. */
  onSignedOut: (origin: string) => void;
}) {
  const { t } = useTranslation();
  const { instances, signOut } = useInstances();
  const { theme, language } = useSettings();
  const instance = origin ? instances.find((i) => i.origin === origin) : undefined;
  const [pushToTalk, setPushToTalk] = useState(() => loadPrefs(voicePrefsStore).pushToTalk);

  const changePushToTalk = (next: boolean) => {
    setPushToTalk(next);
    savePrefs({ ...loadPrefs(voicePrefsStore), pushToTalk: next }, voicePrefsStore);
  };

  const confirmSignOut = () => {
    if (!instance) return;
    Alert.alert(t('settings.signOutConfirm', { server: instance.name }), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('settings.signOut'),
        style: 'destructive',
        onPress: () => {
          onSignedOut(instance.origin);
          void signOut(instance.origin);
        },
      },
    ]);
  };

  return (
    <Screen
      title={t('settings.title')}
      subtitle={instance?.name}
      onBack={onBack}
      backLabel={t('common.back')}
    >
      {instance?.user ? <Profile origin={instance.origin} /> : null}

      <SectionLabel>{t('settings.app')}</SectionLabel>
      <Group>
        <SettingRow
          label={t('settings.language')}
          below={
            <Segmented<LanguageChoice>
              value={language}
              onChange={setLanguage}
              options={LANGUAGES.map((value) => ({ value, label: languageLabel(value, t) }))}
            />
          }
        />
        <SettingRow
          label={t('settings.theme')}
          last
          below={
            <Segmented<ThemeChoice>
              value={theme}
              onChange={setTheme}
              options={THEMES.map((value) => ({ value, label: themeLabel(value, t) }))}
            />
          }
        />
      </Group>

      <SectionLabel>{t('settings.voice')}</SectionLabel>
      <Group>
        <SettingRow
          label={t('settings.pushToTalk')}
          hint={t('settings.pushToTalkHint')}
          right={
            <Toggle
              value={pushToTalk}
              onValueChange={changePushToTalk}
              label={t('settings.pushToTalk')}
            />
          }
          last
        />
      </Group>

      {instance?.user ? (
        <>
          <SectionLabel>{t('settings.account')}</SectionLabel>
          <Group>
            <SettingRow
              label={t('settings.signOut')}
              tone="destructive"
              onPress={confirmSignOut}
              last
            />
          </Group>
        </>
      ) : null}
    </Screen>
  );
}

function languageLabel(value: LanguageChoice, t: TFunction): string {
  // A language is named in itself, whatever the interface speaks.
  if (value === 'system') return t('settings.languageSystem');
  return value === 'en' ? 'English' : 'Português';
}

function themeLabel(value: ThemeChoice, t: TFunction): string {
  if (value === 'light') return t('settings.themeLight');
  return value === 'dark' ? t('settings.themeDark') : t('settings.themeSystem');
}

/** Name and photo on one server. */
function Profile({ origin }: { origin: string }) {
  const { t } = useTranslation();
  const me = useMe(origin);
  const actions = useProfileActions(origin);
  const headers = useAuthHeaders(useApi(origin));
  const user = me.data?.user;
  const avatar = me.data?.avatar;
  const [name, setName] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const busy =
    actions.rename.isPending ||
    actions.upload.isPending ||
    actions.remove.isPending ||
    actions.discord.isPending;
  const shown = name ?? user?.displayName ?? '';
  const problem = name === null ? null : nameProblem(name);
  const changed = user !== undefined && name !== null && name.trim() !== user.displayName;

  const fail = (error: unknown) => setNotice({ tone: 'error', text: errorText(t, error) });
  const done = (text: string) => setNotice({ tone: 'ok', text });

  const save = () => {
    if (!changed || problem) return;
    setNotice(null);
    actions.rename.mutate(name.trim(), {
      onSuccess: () => {
        setName(null);
        done(t('settings.nameSaved'));
      },
      onError: fail,
    });
  };

  const pick = async (source: PhotoSource) => {
    setNotice(null);
    const photo = await choosePhoto(source);
    if (!photo.ok) {
      if (photo.reason === 'cancelled') return;
      const text = {
        denied: t('settings.photo.denied'),
        size: t('settings.photo.tooBig'),
        unreadable: t('settings.photo.unreadable'),
      }[photo.reason];
      setNotice({ tone: 'error', text });
      return;
    }
    actions.upload.mutate(photo, {
      onSuccess: () => done(t('settings.photo.saved')),
      onError: fail,
    });
  };

  const remove = () => {
    setNotice(null);
    actions.remove.mutate(undefined, {
      onSuccess: () => done(t('settings.photo.removed')),
      onError: fail,
    });
  };

  const useDiscord = () => {
    setNotice(null);
    actions.discord.mutate(undefined, {
      onSuccess: () => done(t('settings.photo.saved')),
      onError: fail,
    });
  };

  const offerDiscord =
    avatar?.discordAvailable === true && !(avatar.source === 'discord' && user?.avatarUrl);

  return (
    <>
      <SectionLabel>{t('settings.profile')}</SectionLabel>
      <Card>
        {user ? (
          <>
            <Row>
              <AvatarSourceProvider origin={origin} headers={headers}>
                <Avatar name={user.displayName} url={user.avatarUrl} size={64} />
              </AvatarSourceProvider>
              <View style={styles.photoActions}>
                <View style={styles.buttons}>
                  <Button
                    label={t('settings.photo.gallery')}
                    variant="outline"
                    compact
                    disabled={busy}
                    onPress={() => void pick(GALLERY)}
                  />
                  <Button
                    label={t('settings.photo.camera')}
                    variant="outline"
                    compact
                    disabled={busy}
                    onPress={() => void pick(CAMERA)}
                  />
                </View>
                <View style={styles.buttons}>
                  {user.avatarUrl ? (
                    <Button
                      label={t('settings.photo.remove')}
                      variant="outline"
                      compact
                      disabled={busy}
                      onPress={remove}
                    />
                  ) : null}
                  {offerDiscord ? (
                    <Button
                      label={t('settings.photo.discord')}
                      variant="outline"
                      compact
                      disabled={busy}
                      onPress={useDiscord}
                    />
                  ) : null}
                </View>
              </View>
            </Row>
            <Field
              label={t('settings.name')}
              value={shown}
              onChangeText={(value) => {
                setName(value);
                setNotice(null);
              }}
              autoComplete="nickname"
              maxLength={DISPLAY_NAME_MAX + 20}
              returnKeyType="done"
              onSubmitEditing={save}
            />
            {problem ? (
              <Body tone="destructive">
                {problem === 'required'
                  ? t('settings.nameRequired')
                  : t('settings.nameTooLong', { max: DISPLAY_NAME_MAX })}
              </Body>
            ) : null}
            {changed ? (
              <Button
                label={t('settings.save')}
                busy={actions.rename.isPending}
                disabled={problem !== null || busy}
                onPress={save}
              />
            ) : null}
            {notice ? (
              <Body
                tone={notice.tone === 'error' ? 'destructive' : undefined}
                muted={notice.tone === 'ok'}
              >
                {notice.text}
              </Body>
            ) : null}
          </>
        ) : me.isError ? (
          <Body tone="destructive">{errorText(t, me.error)}</Body>
        ) : (
          <Body muted>{t('mobile.loading')}</Body>
        )}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  photoActions: { flex: 1, gap: 6 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
