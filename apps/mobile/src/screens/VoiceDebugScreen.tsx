// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { audio } from '../audio/index.ts';
import { Body, Button, Card, Heading, Screen } from '../components/ui.tsx';
import { hostOf } from '../lib/host.ts';
import { useInstances } from '../state.tsx';
import { useTheme } from '../theme.ts';
import {
  onNotificationAction,
  requestMicPermission,
  requestNotificationPermission,
  setRoute,
  startVoiceSession,
  stopVoiceSession,
  voice,
  VoiceSessionError,
} from '../voice-native/index.ts';

/**
 * A test bench for the phone side of voice (A3-M), before the voice client exists: start and stop a
 * session (foreground service and notification), pick the route and watch a microphone level meter.
 * Reached by tapping the version on the first screen five times.
 */
export function VoiceDebugScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { instances } = useInstances();
  const snapshot = useSyncExternalStore(voice.subscribe, voice.getSnapshot);
  const mode = useSyncExternalStore(audio.subscribe, () => audio.mode);
  const [log, setLog] = useState<string>('-');
  const [error, setError] = useState<string | null>(null);
  const [meter, setMeter] = useState<number | null>(null);
  const stopMeter = useRef<(() => void) | null>(null);
  const instance = instances[0];
  const server = instance ? `${instance.name} · ${hostOf(instance.origin)}` : 'Openlive test';

  // The notification's buttons: the session applies mute and unmute; leave ends it here.
  useEffect(
    () =>
      onNotificationAction((action) => {
        setLog(`${new Date().toLocaleTimeString()} ${action}`);
        if (action === 'leave') stopVoiceSession();
      }),
    [],
  );
  useEffect(
    () =>
      voice.onSessionEnded((reason) =>
        setLog(`${new Date().toLocaleTimeString()} ended: ${reason}`),
      ),
    [],
  );
  useEffect(() => () => stopMeter.current?.(), []);

  const toggleMeter = async () => {
    if (stopMeter.current) {
      stopMeter.current();
      stopMeter.current = null;
      setMeter(null);
      return;
    }
    setError(null);
    if ((await requestMicPermission()) !== 'granted') return;
    try {
      stopMeter.current = voice.startMicMeter(setMeter);
      setMeter(0);
    } catch (e) {
      setError(String(e));
    }
  };

  const start = async () => {
    setError(null);
    try {
      if ((await requestMicPermission()) !== 'granted')
        throw new VoiceSessionError('mic_permission');
      await startVoiceSession({
        roomName: 'test',
        serverName: instance?.name ?? 'Openlive test',
        ...(instance ? { serverAddress: hostOf(instance.origin) } : {}),
      });
    } catch (e) {
      setError(
        t('voice.debug.error', { code: e instanceof VoiceSessionError ? e.code : String(e) }),
      );
    }
  };

  const active = snapshot.state === 'active';
  return (
    <Screen title={t('voice.debug.title')} onBack={onBack} backLabel={t('home.title')}>
      {!voice.supported ? <Body tone="warning">{t('voice.debug.unsupported')}</Body> : null}
      <Card>
        <Heading>{t('voice.debug.state.' + snapshot.state)}</Heading>
        <Body muted>{`${t('voice.debug.server')}: ${server}`}</Body>
        <Body muted>{`${t('voice.debug.room')}: #test`}</Body>
        <Body muted>{`audio mode: ${mode ?? '-'}`}</Body>
        {error ? <Body tone="destructive">{error}</Body> : null}
        <Button
          label={t(active ? 'voice.debug.stop' : 'voice.debug.start')}
          variant={active ? 'destructive' : 'primary'}
          busy={snapshot.state === 'starting'}
          onPress={() => (active ? stopVoiceSession() : void start())}
        />
        <Button
          label={t(snapshot.muted ? 'voice.debug.unmute' : 'voice.debug.mute')}
          variant="outline"
          disabled={!active}
          onPress={() => voice.setMuted(!snapshot.muted)}
        />
        <Body muted>{`${t('voice.debug.lastEvent')}: ${log}`}</Body>
      </Card>

      <Card>
        <Heading>{t('voice.debug.route')}</Heading>
        <Body muted>{`${t('voice.debug.active')}: ${snapshot.active}`}</Body>
        <Body muted>{`${t('voice.debug.available')}: ${snapshot.available.join(', ')}`}</Body>
        {ROUTES.map(([route, label]) => (
          <Button
            key={route}
            label={t(label)}
            variant={snapshot.route === route ? 'primary' : 'outline'}
            onPress={() => setRoute(route)}
          />
        ))}
      </Card>

      <Card>
        <Heading>{t('voice.debug.device')}</Heading>
        <Body muted>
          {snapshot.device
            ? `${t('voice.debug.aec')}: ${yesNo(t, snapshot.device.hardwareAec)}\n${t('voice.debug.ns')}: ${yesNo(t, snapshot.device.hardwareNs)}\n${t('voice.debug.swapped')}: ${yesNo(t, snapshot.device.swapped)}`
            : '-'}
        </Body>
      </Card>

      <Card>
        <Heading>{t('voice.debug.meter')}</Heading>
        <View style={[styles.track, { backgroundColor: colors.border }]}>
          <View
            style={[
              styles.level,
              { backgroundColor: colors.primary, width: `${Math.round((meter ?? 0) * 100)}%` },
            ]}
          />
        </View>
        <Text style={{ color: colors.mutedForeground }}>
          {meter === null ? '-' : meter.toFixed(2)}
        </Text>
        <Button
          label={t(meter === null ? 'voice.debug.meterStart' : 'voice.debug.meterStop')}
          variant="outline"
          onPress={() => void toggleMeter()}
        />
      </Card>

      <Card>
        <Heading>{t('voice.debug.permissions')}</Heading>
        <Button
          label={t('voice.debug.micPermission')}
          variant="outline"
          onPress={() => void requestMicPermission()}
        />
        <Button
          label={t('voice.debug.notificationPermission')}
          variant="outline"
          onPress={() => void requestNotificationPermission()}
        />
      </Card>
    </Screen>
  );
}

const ROUTES = [
  ['auto', 'voice.debug.routeAuto'],
  ['speaker', 'voice.debug.routeSpeaker'],
  ['earpiece', 'voice.debug.routeEarpiece'],
] as const;

const yesNo = (t: (key: string) => string, value: boolean): string =>
  t(value ? 'voice.debug.yes' : 'voice.debug.no');

const styles = StyleSheet.create({
  track: { height: 12, borderRadius: 6, overflow: 'hidden' },
  level: { height: 12 },
});
