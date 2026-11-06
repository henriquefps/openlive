// SPDX-License-Identifier: AGPL-3.0-only
import { DesktopTower, DeviceMobile, Devices as DevicesIcon } from 'phosphor-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { NOTICE_KINDS } from '@openlive/client';
import { useSyncExternalStore } from 'react';
import { useDevices, useRevokeDevice, useRevokeSession, useSessions } from '../account-queries.ts';
import {
  Badge,
  Body,
  Button,
  Card,
  Group,
  Row,
  SectionLabel,
  SettingRow,
  Toggle,
} from '../components/ui.tsx';
import { Skeleton } from '../components/ui/index.ts';
import i18n from '../i18n/index.ts';
import { formatWhen, sessionName, sessionWhen } from '../lib/account-view.ts';
import { noticeSettings } from '../notices/notify.ts';
import { font, useTheme } from '../theme.ts';
import { ErrorLine, QueryFailure } from './space/shared.tsx';

/** Settings > Sessions: the browsers and apps signed in to the account, each with a revoke button. */
export function SessionsSection({ origin }: { origin: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const sessions = useSessions(origin);
  const revoke = useRevokeSession(origin);
  const when = (at: number) => formatWhen(at, i18n.language);
  return (
    <>
      <SectionLabel>{t('settings.sessions.title')}</SectionLabel>
      <Body muted>{t('settings.sessions.description')}</Body>
      {sessions.isPending ? <Skeleton height={56} /> : null}
      {sessions.isError ? (
        <QueryFailure error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : null}
      {sessions.data?.map((session) => {
        const name = sessionName(session, t);
        const Icon = session.kind === 'app' ? DeviceMobile : DevicesIcon;
        return (
          <Card key={session.id}>
            <Row>
              <Icon size={20} color={colors.mutedForeground} />
              <View style={styles.grow}>
                <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={2}>
                  {name}
                </Text>
                <Text style={[styles.meta, { color: colors.mutedForeground }]}>
                  {sessionWhen(session, t, when)}
                </Text>
              </View>
              {session.current ? (
                <Badge
                  tone="outline"
                  label={t(
                    session.kind === 'app'
                      ? 'settings.sessions.currentApp'
                      : 'settings.sessions.current',
                  )}
                />
              ) : (
                <Button
                  label={t('settings.sessions.revoke')}
                  accessibilityLabel={t('settings.sessions.revokeLabel', { name })}
                  variant="outline"
                  compact
                  disabled={revoke.isPending}
                  onPress={() => revoke.mutate(session.id)}
                />
              )}
            </Row>
          </Card>
        );
      })}
      <ErrorLine error={revoke.error} />
    </>
  );
}

/** Settings > Devices: the paired helpers with a revoke button (their live status needs the hub). */
export function DevicesSection({ origin }: { origin: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const devices = useDevices(origin);
  const revoke = useRevokeDevice(origin);
  const when = (at: number) => formatWhen(at, i18n.language);
  return (
    <>
      <SectionLabel>{t('settings.devices.title')}</SectionLabel>
      <Body muted>{t('settings.devices.description')}</Body>
      {devices.isPending ? <Skeleton height={56} /> : null}
      {devices.isError ? (
        <QueryFailure error={devices.error} onRetry={() => void devices.refetch()} />
      ) : null}
      {devices.data?.length === 0 ? <Body muted>{t('settings.devices.empty')}</Body> : null}
      {devices.data?.map((device) => (
        <Card key={device.deviceId}>
          <Row>
            <DesktopTower size={20} color={colors.mutedForeground} />
            <View style={styles.grow}>
              <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
                {device.name}
              </Text>
              <Text style={[styles.meta, { color: colors.mutedForeground }]}>
                {t('settings.devices.system', {
                  os: t(`download.os.${device.os}`),
                  arch: device.arch,
                  version: device.helperVersion,
                })}
              </Text>
              <Text style={[styles.meta, { color: colors.mutedForeground }]}>
                {device.lastSeenAt !== undefined
                  ? t('settings.devices.lastSeen', { date: when(device.lastSeenAt) })
                  : t('settings.devices.pairedAt', { date: when(device.createdAt) })}
              </Text>
            </View>
            <Button
              label={t('settings.devices.revoke')}
              accessibilityLabel={t('settings.devices.revokeLabel', { name: device.name })}
              variant="outline"
              compact
              disabled={revoke.isPending}
              onPress={() => revoke.mutate(device.deviceId)}
            />
          </Row>
        </Card>
      ))}
      <ErrorLine error={revoke.error} />
    </>
  );
}

/** Settings > Notifications: each notice on or off, and "mute all" (the toasts stay). */
export function NoticesSection() {
  const { t } = useTranslation();
  const settings = useSyncExternalStore(noticeSettings.subscribe, noticeSettings.get);
  return (
    <>
      <SectionLabel>{t('notices.settings.title')}</SectionLabel>
      <Group>
        <SettingRow
          label={t('notices.settings.muteAll')}
          hint={t('notices.settings.muteAllHint')}
          right={
            <Toggle
              label={t('notices.settings.muteAll')}
              value={settings.muted}
              onValueChange={(muted) => noticeSettings.update({ muted })}
            />
          }
        />
        {NOTICE_KINDS.map((kind, index) => (
          <SettingRow
            key={kind}
            label={t(`notices.settings.kinds.${kind}`)}
            hint={t(`notices.settings.hints.${kind}`)}
            last={index === NOTICE_KINDS.length - 1}
            right={
              <Toggle
                label={t(`notices.settings.kinds.${kind}`)}
                value={settings.events[kind]}
                onValueChange={(on) => noticeSettings.update({ events: { [kind]: on } })}
              />
            }
          />
        ))}
      </Group>
    </>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, gap: 1 },
  name: { fontFamily: font.medium, fontSize: 15 },
  meta: { fontFamily: font.regular, fontSize: 13 },
});
