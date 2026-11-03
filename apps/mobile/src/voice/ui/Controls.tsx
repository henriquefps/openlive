// SPDX-License-Identifier: AGPL-3.0-only
import type { CameraClient, CameraClientState, VoiceClient } from '@openlive/client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import type { MediaStreamTrack } from 'react-native-webrtc';
import {
  CAMERA,
  FLIP,
  Glyph,
  type GlyphName,
  HEADPHONES,
  LEAVE,
  MIC,
  SETTINGS,
  SOUND,
} from '../../components/Glyph.tsx';
import { Body, Button } from '../../components/ui.tsx';
import { font, radius, useTheme } from '../../theme.ts';
import {
  type ActiveRoute,
  openAppSettings,
  type RoutePreference,
  setRoute,
  voice as nativeVoice,
} from '../../voice-native/index.ts';
import type { PhoneVoice, PhoneVoiceState } from '../phone-voice.ts';
import { pttPressed, type PttEvent } from '../rules.ts';
import { micProblem, voiceControls } from '../view.ts';
import { Sheet } from './Sheet.tsx';

// The call's controls on a phone: mute (or the big hold-to-talk button in push-to-talk), deafen,
// camera and flip, the audio route, the microphone mode and leave. The status line and the
// banners say what the microphone is doing and why it may not be.

type Sheets = 'route' | 'mode';
const ROUTE: Sheets = 'route';
const MODE: Sheets = 'mode';
const DOWN: PttEvent = 'down';
const UP: PttEvent = 'up';
const AUTO: RoutePreference = 'auto';

export function ControlBar({
  phone,
  state,
  cameraClient,
  camera,
  canUseCamera,
  onLeave,
}: {
  phone: PhoneVoice<MediaStreamTrack>;
  state: PhoneVoiceState;
  cameraClient: CameraClient<MediaStreamTrack> | null;
  camera: CameraClientState<MediaStreamTrack> | null;
  canUseCamera: boolean;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const client = phone.client;
  const c = voiceControls(state);
  const [sheet, setSheet] = useState<Sheets | null>(null);
  const cameraOn = camera !== null && camera.phase !== 'off';
  const problem = micProblem(state);

  return (
    <View style={styles.bar}>
      <Text
        accessibilityLiveRegion="polite"
        style={[
          styles.status,
          { color: c.status === 'serverMuted' ? colors.destructive : colors.mutedForeground },
        ]}
      >
        {c.status === 'connecting'
          ? t('mobile.voice.status.connecting')
          : t(`mobile.voice.status.${c.status}`)}
      </Text>
      {state.error ? (
        <Body tone="destructive">
          {t(`errors.${state.error.code}`, {
            defaultValue: t('errors.generic', { code: state.error.code }),
          })}
        </Body>
      ) : null}
      {problem ? <Body tone="warning">{t(problem)}</Body> : null}
      {state.micBlocked ? (
        <Button
          label={t('mobile.voice.openSettings')}
          variant="outline"
          onPress={openAppSettings}
        />
      ) : null}
      {camera?.error ? <Body tone="warning">{t(`voice.camera.error.${camera.error}`)}</Body> : null}
      {camera?.refused ? (
        <Body tone="warning">
          {t(`errors.${camera.refused.code}`, {
            defaultValue: t('errors.generic', { code: camera.refused.code }),
          })}
        </Body>
      ) : null}
      {camera?.stopped ? (
        <Body tone="warning">{t(`voice.camera.stopped.${camera.stopped}`)}</Body>
      ) : null}
      {camera?.network === 'bad' ? <Body tone="warning">{t('voice.camera.paused')}</Body> : null}
      {camera?.network === 'poor' ? (
        <Body tone="warning">{t('voice.camera.lowQuality')}</Body>
      ) : null}

      {c.showTalkButton ? <TalkButton client={client} state={state} /> : null}

      <View style={styles.row}>
        {!c.showTalkButton ? (
          <Control
            icon={MIC}
            label={state.muted ? t('voice.unmute') : t('voice.mute')}
            off={state.muted}
            disabled={!c.joined || !c.canMute}
            onPress={() => client.setMuted(!state.muted)}
          />
        ) : null}
        <Control
          icon={HEADPHONES}
          label={state.deafened ? t('voice.undeafen') : t('voice.deafen')}
          off={state.deafened}
          disabled={!c.joined}
          onPress={() => client.setDeafened(!state.deafened)}
        />
        {cameraClient && camera ? (
          <Control
            icon={CAMERA}
            label={cameraOn ? t('voice.camera.turnOff') : t('voice.camera.turnOn')}
            active={cameraOn}
            off={!cameraOn}
            disabled={!c.joined || !canUseCamera || camera.phase === 'starting'}
            onPress={() => void cameraClient.toggle()}
          />
        ) : null}
        {cameraClient && cameraOn ? (
          <Control
            icon={FLIP}
            label={t('voice.camera.flip')}
            disabled={camera?.phase !== 'on'}
            onPress={() => void cameraClient.flip()}
          />
        ) : null}
        <Control
          icon={SOUND}
          label={t('mobile.voice.routeTitle')}
          onPress={() => setSheet(ROUTE)}
        />
        <Control
          icon={SETTINGS}
          label={t('mobile.voice.settings')}
          onPress={() => setSheet(MODE)}
        />
        <Control icon={LEAVE} label={t('voice.leave')} destructive onPress={onLeave} />
      </View>
      {cameraClient && !canUseCamera ? (
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
          {t('voice.camera.notAllowed')}
        </Text>
      ) : null}

      {sheet === ROUTE ? <RouteSheet onClose={() => setSheet(null)} /> : null}
      {sheet === MODE ? (
        <ModeSheet client={client} state={state} onClose={() => setSheet(null)} />
      ) : null}
    </View>
  );
}

/** A round icon button; the label is for accessibility (and the long-press hint). */
function Control({
  icon,
  label,
  onPress,
  off = false,
  active = false,
  disabled = false,
  destructive = false,
}: {
  icon: GlyphName;
  label: string;
  onPress: () => void;
  /** Crossed out: the microphone is muted, the camera is off. */
  off?: boolean;
  active?: boolean;
  disabled?: boolean;
  destructive?: boolean;
}) {
  const { colors } = useTheme();
  const tone = destructive ? colors.destructive : active ? colors.primary : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active || off }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.control,
        {
          backgroundColor: colors.card,
          borderColor: active || destructive ? tone : colors.border,
        },
        (pressed || disabled) && { opacity: 0.55 },
      ]}
    >
      <Glyph
        name={icon}
        size={22}
        slashed={off}
        color={tone}
        weight={active ? 'fill' : 'regular'}
      />
    </Pressable>
  );
}

/** Hold to talk: the microphone is open while the finger is down, wherever it drifts. */
function TalkButton({ client, state }: { client: VoiceClient; state: PhoneVoiceState }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const send = (event: PttEvent) => client.setPttPressed(pttPressed(event));
  // Going to the background with the finger down (a call, the home gesture): the mic closes.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (s) => {
      if (s !== 'active') send('cancel');
    });
    return () => {
      subscription.remove();
      send('cancel');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  const open = state.pttPressed && state.transmitting;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('mobile.voice.talk')}
      accessibilityState={{ selected: open }}
      pressRetentionOffset={{ top: 400, bottom: 400, left: 400, right: 400 }}
      onPressIn={() => send(DOWN)}
      onPressOut={() => send(UP)}
      style={[
        styles.talk,
        {
          backgroundColor: open ? colors.primary : colors.card,
          borderColor: colors.primary,
        },
      ]}
    >
      <Text style={[styles.talkText, { color: open ? colors.primaryForeground : colors.primary }]}>
        {open ? t('mobile.voice.talking') : t('mobile.voice.talk')}
      </Text>
    </Pressable>
  );
}

const ROUTE_CHOICES: { route: RoutePreference; label: string; hint?: string }[] = [
  { route: 'auto', label: 'mobile.voice.route.auto', hint: 'mobile.voice.route.autoHint' },
  { route: 'speaker', label: 'mobile.voice.route.speaker' },
  { route: 'earpiece', label: 'mobile.voice.route.earpiece' },
];

const ROUTE_LABEL: Record<ActiveRoute, string> = {
  speaker: 'mobile.voice.route.speaker',
  earpiece: 'mobile.voice.route.earpiece',
  wired: 'mobile.voice.route.wired',
  bluetooth: 'mobile.voice.route.bluetooth',
};

/**
 * Where the sound goes: automatic (a wired or Bluetooth headset first, else the speaker), the
 * speaker or the earpiece. A headset that is plugged in or paired shows up as available and is
 * used in automatic; the system picks which when there are two.
 */
function RouteSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const snapshot = useSyncExternalStore(nativeVoice.subscribe, nativeVoice.getSnapshot);
  const headsets = snapshot.available.filter((r) => r === 'wired' || r === 'bluetooth');
  return (
    <Sheet title={t('mobile.voice.routeTitle')} onClose={onClose}>
      <Text style={[styles.hint, { color: colors.mutedForeground }]}>
        {t('mobile.voice.route.playingThrough', { route: t(ROUTE_LABEL[snapshot.active]) })}
      </Text>
      {ROUTE_CHOICES.filter(
        (choice) => choice.route !== 'earpiece' || snapshot.available.includes('earpiece'),
      ).map((choice) => (
        <Choice
          key={choice.route}
          label={t(choice.label)}
          hint={choice.hint ? t(choice.hint) : undefined}
          selected={snapshot.route === choice.route}
          onPress={() => setRoute(choice.route)}
        />
      ))}
      {headsets.map((route) => (
        <Choice
          key={route}
          label={t(ROUTE_LABEL[route])}
          selected={snapshot.route === 'auto' && snapshot.active === route}
          onPress={() => setRoute(AUTO)}
        />
      ))}
    </Sheet>
  );
}

function ModeSheet({
  client,
  state,
  onClose,
}: {
  client: VoiceClient;
  state: PhoneVoiceState;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <Sheet title={t('mobile.voice.mode.title')} onClose={onClose}>
      <Choice
        label={t('mobile.voice.mode.open')}
        selected={!state.pushToTalk}
        onPress={() => client.setPushToTalk(false)}
      />
      <Choice
        label={t('mobile.voice.mode.ptt')}
        selected={state.pushToTalk}
        onPress={() => client.setPushToTalk(true)}
      />
      <Text style={[styles.hint, { color: colors.mutedForeground }]}>
        {t('mobile.voice.mode.hint')}
      </Text>
      <Button label={t('mobile.voice.close')} variant="outline" onPress={onClose} />
    </Sheet>
  );
}

function Choice({
  label,
  hint,
  selected,
  onPress,
}: {
  label: string;
  hint?: string | undefined;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.choice,
        { borderColor: selected ? colors.primary : colors.border, backgroundColor: colors.card },
      ]}
    >
      <Text style={[styles.controlText, { color: selected ? colors.primary : colors.foreground }]}>
        {label}
      </Text>
      {hint ? <Text style={[styles.hint, { color: colors.mutedForeground }]}>{hint}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { gap: 6 },
  row: { flexDirection: 'row', gap: 6 },
  status: { fontFamily: font.medium, fontSize: 13 },
  hint: { fontFamily: font.regular, fontSize: 13 },
  control: {
    flex: 1,
    minHeight: 44,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlText: { fontFamily: font.medium, fontSize: 14, textAlign: 'center' },
  talk: {
    minHeight: 64,
    borderRadius: radius.card,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  talkText: { fontFamily: font.semibold, fontSize: 18 },
  choice: { minHeight: 48, borderRadius: radius.control, borderWidth: 1, padding: 12, gap: 2 },
});
