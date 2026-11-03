// SPDX-License-Identifier: AGPL-3.0-only
import type { Space } from '@openlive/client';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Avatar,
  AvatarSourceProvider,
  Body,
  Button,
  Card,
  Empty,
  Heading,
  InstanceIcon,
  Row,
  Screen,
} from '../components/ui.tsx';
import { OfflineHint } from '../components/OfflineHint.tsx';
import { errorText } from '../i18n/errors.ts';
import { hostOf } from '../lib/host.ts';
import { FEATURE_INVITE_DEEP_LINK } from '../lib/instance.ts';
import { useApi, useAuthHeaders } from '../hooks.ts';
import { useAcceptInvite, useInvitePreview, useSpaces } from '../queries.ts';
import { useInstances } from '../state.tsx';
import { font, useTheme } from '../theme.ts';

/**
 * One instance: who is signed in and their spaces (proof that the token works), an invite that
 * came with a link, sign in and sign out.
 */
export function InstanceScreen({
  origin,
  invite,
  expired: wasExpired = false,
  onBack,
  onRemoved,
  onInviteDone,
  onOpenSpace,
  onSettings,
}: {
  origin: string;
  invite?: string | undefined;
  /** The session ended while a space or room was open: say so above the sign-in button. */
  expired?: boolean;
  onBack: () => void;
  onRemoved: () => void;
  onInviteDone: () => void;
  onOpenSpace: (space: Space) => void;
  /** The profile and settings of this server's account. */
  onSettings: () => void;
}) {
  const { t } = useTranslation();
  const { instances, signIn, signOut, remove, lost } = useInstances();
  const instance = instances.find((i) => i.origin === origin);
  const spaces = useSpaces(origin);
  const headers = useAuthHeaders(useApi(origin));
  const [pulling, setPulling] = useState(false);
  const [busy, setBusy] = useState<'signIn' | 'signOut' | 'remove' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const signedIn = Boolean(instance?.user);
  // The route says the session ended before this screen; once signed in again that is history.
  const [reauthed, setReauthed] = useState(false);
  if (signedIn && !reauthed) setReauthed(true);
  const expired = !signedIn && ((wasExpired && !reauthed) || lost.has(origin));

  // Pull to refresh: the spinner is the pull's own, not the background revalidation's.
  const pull = () => {
    setPulling(true);
    void spaces.refetch().finally(() => setPulling(false));
  };

  if (!instance) return null;

  const doSignIn = async () => {
    setBusy('signIn');
    setNotice(null);
    const outcome = await signIn(origin, invite);
    setBusy(null);
    if (!outcome.ok) {
      setNotice(
        outcome.reason === 'error' ? errorText(t, outcome.code) : t(`login.${outcome.reason}`),
      );
    }
  };

  const retry = () => void spaces.refetch();

  const doSignOut = () => {
    setBusy('signOut');
    void signOut(origin).finally(() => setBusy(null));
  };

  const doRemove = () => {
    setBusy('remove');
    void remove(origin).then(onRemoved);
  };

  // Features unknown (an older save): the link came from the instance, so it offers invites.
  const inviteToken =
    invite && instance.features?.includes(FEATURE_INVITE_DEEP_LINK) !== false ? invite : null;

  return (
    <Screen
      title={instance.name}
      subtitle={instance.name !== hostOf(origin) ? hostOf(origin) : undefined}
      onBack={onBack}
      backLabel={t('common.back')}
      refreshing={pulling}
      onRefresh={signedIn ? pull : undefined}
      headerRight={
        instance.user ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('settings.open')}
            onPress={onSettings}
            hitSlop={8}
          >
            <AvatarSourceProvider origin={origin} headers={headers}>
              <Avatar name={instance.user.displayName} url={instance.user.avatarUrl} size={40} />
            </AvatarSourceProvider>
          </Pressable>
        ) : undefined
      }
    >
      <Card>
        <Row>
          <InstanceIcon name={instance.name} iconUrl={instance.iconUrl} />
          <View style={{ flex: 1 }}>
            <Heading>{instance.name}</Heading>
            <Body muted>
              {instance.user
                ? t('home.signedInAs', { name: instance.user.displayName })
                : t('home.signedOut')}
            </Body>
          </View>
        </Row>
      </Card>

      {inviteToken ? (
        signedIn && spaces.isSuccess ? (
          <InviteCard origin={origin} token={inviteToken} onDone={onInviteDone} />
        ) : (
          <Card>
            <Body>{t('invite.signInFirst')}</Body>
          </Card>
        )
      ) : null}

      <OfflineHint hasData={signedIn && spaces.data !== undefined} />
      {signedIn && spaces.isPending && spaces.fetchStatus !== 'paused' ? (
        <Body muted>{t('add.checking')}</Body>
      ) : null}
      {signedIn && spaces.data === undefined && spaces.isError ? (
        <>
          <Body tone="destructive">{errorText(t, spaces.error)}</Body>
          <Button label={t('common.retry')} variant="outline" onPress={retry} />
        </>
      ) : null}
      {!signedIn ? (
        <>
          <Body tone={expired ? 'warning' : undefined} muted={!expired}>
            {expired ? t('instance.expired') : t('instance.signedOutHint')}
          </Body>
          <Button
            label={busy === 'signIn' ? t('instance.signingIn') : t('instance.signIn')}
            busy={busy === 'signIn'}
            onPress={() => void doSignIn()}
          />
        </>
      ) : null}
      {signedIn && spaces.data ? <Spaces spaces={spaces.data} onOpen={onOpenSpace} /> : null}
      {notice ? <Body tone="destructive">{notice}</Body> : null}

      <View style={styles.footer}>
        {signedIn ? (
          <Button
            label={t('instance.signOut')}
            variant="outline"
            busy={busy === 'signOut'}
            onPress={doSignOut}
          />
        ) : null}
        <Button
          label={t('instance.remove')}
          variant="destructive"
          busy={busy === 'remove'}
          onPress={doRemove}
        />
      </View>
    </Screen>
  );
}

function Spaces({ spaces, onOpen }: { spaces: Space[]; onOpen: (space: Space) => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <>
      <Heading>{t('instance.spaces')}</Heading>
      {spaces.length === 0 ? (
        <Empty title={t('instance.noSpaces')} hint={t('instance.noSpacesHint')} />
      ) : null}
      {spaces.map((space) => (
        <Card key={space.id} onPress={() => onOpen(space)}>
          <View style={styles.space}>
            <Text style={[styles.spaceName, { color: colors.foreground }]} numberOfLines={1}>
              {space.name}
            </Text>
            {space.role ? (
              <Text style={[styles.role, { color: colors.mutedForeground }]}>
                {t(`instance.role.${space.role}`)}
              </Text>
            ) : null}
          </View>
        </Card>
      ))}
    </>
  );
}

function InviteCard({
  origin,
  token,
  onDone,
}: {
  origin: string;
  token: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const previewQuery = useInvitePreview(origin, token);
  const accept = useAcceptInvite(origin, token);
  const preview = previewQuery.data;
  const error = accept.error ?? previewQuery.error;
  const result = accept.data;

  if (error) {
    return (
      <Card>
        <Body tone="destructive">{errorText(t, error)}</Body>
        <Button label={t('invite.dismiss')} variant="outline" onPress={onDone} />
      </Card>
    );
  }
  if (!preview) return null;
  return (
    <Card>
      <Heading>{t('invite.title', { space: preview.spaceName })}</Heading>
      {preview.roomName ? <Body muted>{t('invite.room', { room: preview.roomName })}</Body> : null}
      <Body muted>{t('invite.asRole', { role: t(`instance.role.${preview.role}`) })}</Body>
      {result ? (
        <>
          <Body>
            {result.status === 'joined'
              ? t('invite.joined', { space: preview.spaceName })
              : t('invite.pending')}
          </Body>
          <Button label={t('common.back')} variant="outline" onPress={onDone} />
        </>
      ) : (
        <>
          <Button
            label={preview.requiresApproval ? t('invite.request') : t('invite.accept')}
            busy={accept.isPending}
            onPress={() => accept.mutate()}
          />
          <Button label={t('invite.dismiss')} variant="outline" onPress={onDone} />
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  footer: { marginTop: 'auto', gap: 8, paddingTop: 16 },
  space: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  spaceName: { fontFamily: font.medium, fontSize: 15, flex: 1 },
  role: { fontFamily: font.regular, fontSize: 13 },
});
