// SPDX-License-Identifier: AGPL-3.0-only
import { type IdleState, type ScreenKind, VIDEO_SCREENS } from '@openlive/client';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as NavigationBar from 'expo-navigation-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { CaretLeft, CellSignalLow } from 'phosphor-react-native';
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { SavedInstance } from '../lib/storage.ts';
import { font, useTheme } from '../theme.ts';
import type { WatchController, WatchSnapshot } from './controller.ts';
import { layerLabel, layerOf, qualityOptions, statsLines } from './format.ts';
import { audio, focusGain, releaseMedia, setAudioMode } from '../audio/index.ts';
import { setAudioVolume, type RnSource } from './rtc.ts';
import { useWatch, useWatchSnapshot } from './useWatch.ts';
import {
  deviceRotation,
  INITIAL_ROTATION,
  needsSettle,
  rotationReducer,
  SETTLE_MS,
  SETTLE_ROTATION,
  TOGGLE_ROTATION,
} from './rotation.ts';
import { DEFAULT_VOLUME, effectiveVolume, stepVolume, type VolumeSetting } from './volume.ts';

// The stream player: the video (RTCView), what to show while there is none (connecting, the queue,
// full, paused, ended...), the controls (quality, volume, landscape, stats) and the rules of a
// phone (screen on while watching, slot back when the app is away, back button).

export interface StreamViewProps {
  instance: SavedInstance;
  roomId: string;
  streamId: string;
  onClose: () => void;
}

const CONTROLS_MS = 4000;
// Non-text props, kept out of the JSX so the literal-string rule only sees words.
const TOP_EDGES = ['top', 'left', 'right'] as const;
const BOTTOM_EDGES = ['bottom', 'left', 'right'] as const;
const STATS_EDGES = ['top', 'right'] as const;
const NO_TOUCH = 'none';
const PASS_TOUCH = 'box-none';
const CONTAIN = 'contain';
const FADE = 'fade';
const LARGE = 'large';
const WHITE = '#fbfbf9';
const BADGE_EDGES = ['top', 'right'] as const;
const SCRIM = 'rgba(0,0,0,0.55)';

/**
 * "Unstable connection": a small weak-signal icon in the video's top-right corner (also in
 * landscape, inside the safe area); tapping it shows the label for a few seconds.
 */
function UnstableBadge({ label, lowered }: { label: string; lowered: boolean }): React.JSX.Element {
  const [tip, setTip] = useState(false);
  useEffect(() => {
    if (!tip) return;
    const timer = setTimeout(() => setTip(false), 3000);
    return () => clearTimeout(timer);
  }, [tip]);
  return (
    <SafeAreaView
      style={[styles.badge, lowered ? styles.badgeLow : null]}
      edges={BADGE_EDGES}
      pointerEvents={PASS_TOUCH}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => setTip((v) => !v)}
        onLongPress={() => setTip(true)}
        hitSlop={8}
        style={styles.badgeIcon}
      >
        <CellSignalLow size={20} color={WHITE} />
      </Pressable>
      {tip ? (
        <View style={styles.badgeTip} pointerEvents={NO_TOUCH}>
          <Text style={styles.small}>{label}</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

export function StreamView({ instance, roomId, streamId, onClose }: StreamViewProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const watch = useWatch(instance, roomId, streamId, onClose);
  const snapshot = useWatchSnapshot(watch);
  const [volume, setVolume] = useState<VolumeSetting>(DEFAULT_VOLUME);
  const [rotation, rotate] = useReducer(rotationReducer, INITIAL_ROTATION);
  const landscape = rotation.fullscreen;
  const [controls, setControls] = useState(true);
  const [stats, setStats] = useState(false);
  const [menu, setMenu] = useState(false);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reveal = useCallback(() => {
    // Any touch is activity for brake 6 ("Still watching?").
    watch.controller.activity();
    setControls(true);
    if (hide.current) clearTimeout(hide.current);
    hide.current = setTimeout(() => setControls(false), CONTROLS_MS);
  }, [watch]);
  useEffect(() => {
    hide.current = setTimeout(() => setControls(false), CONTROLS_MS);
    return () => {
      if (hide.current) clearTimeout(hide.current);
    };
  }, []);

  const source = snapshot?.source ?? null;
  const screen = snapshot?.screen ?? 'connecting';
  const watching = source !== null && snapshot?.presence === 'foreground';

  // The screen stays on while a stream is on it.
  useEffect(() => {
    if (!watching) return;
    void activateKeepAwakeAsync('openlive-player');
    return () => void deactivateKeepAwake('openlive-player');
  }, [watching]);

  // Watching plays as media: the volume keys move the media volume, Bluetooth uses A2DP, and the
  // player holds audio focus (a call or other music takes it, `focus` below). Leaving gives it back.
  useEffect(() => {
    setAudioMode('media');
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') audio.refocus();
    });
    return () => {
      appState.remove();
      releaseMedia();
    };
  }, []);
  const focus = useSyncExternalStore(audio.subscribe, audio.getFocus);

  // Volume and mute follow the audio tracks the pull brings in, times what audio focus allows.
  const sourceKind = snapshot?.sourceState?.kind ?? null;
  useEffect(() => {
    if (source) setAudioVolume(source.stream, effectiveVolume(volume) * focusGain(focus));
  }, [source, sourceKind, volume, focus]);

  // Rotation: the phone's turn is followed while the player is open (landscape is full screen);
  // the button is a manual choice that wins (rotation.ts). Leaving always goes back to portrait.
  useEffect(() => {
    const sub = ScreenOrientation.addOrientationChangeListener((event) =>
      rotate(deviceRotation(event.orientationInfo.orientation)),
    );
    return () => ScreenOrientation.removeOrientationChangeListener(sub);
  }, []);
  useEffect(() => {
    const lock =
      rotation.lock === 'landscape'
        ? ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE)
        : rotation.lock === 'portrait'
          ? ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
          : // Unlocked: the system's auto-rotate setting decides.
            ScreenOrientation.unlockAsync();
    void lock.catch(() => undefined);
  }, [rotation.lock]);
  useEffect(() => {
    if (!needsSettle(rotation)) return;
    const timer = setTimeout(() => rotate(SETTLE_ROTATION), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [rotation]);
  useEffect(
    () => () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(
        () => undefined,
      );
      void NavigationBar.setVisibilityAsync('visible').catch(() => undefined);
    },
    [],
  );
  // Full screen: the system bars go too (the status bar is the StatusBar below).
  useEffect(() => {
    void NavigationBar.setVisibilityAsync(landscape ? 'hidden' : 'visible').catch(() => undefined);
  }, [landscape]);

  const close = useCallback(() => {
    watch?.controller.close();
    onClose();
  }, [watch, onClose]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (landscape) rotate(TOGGLE_ROTATION);
      else close();
      return true;
    });
    return () => sub.remove();
  }, [landscape, close]);

  const name = snapshot?.ownerName ?? t('player.someone');
  const showVideo = source !== null && VIDEO_SCREENS.has(screen);
  const onVideo = source !== null && (showVideo || screen === 'reconnecting');

  return (
    <View style={styles.root} onTouchStart={() => watch.controller.activity()}>
      <StatusBar hidden={landscape} style="light" />
      {onVideo && source ? (
        <RTCView streamURL={source.stream.toURL()} objectFit={CONTAIN} style={styles.video} />
      ) : null}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={reveal}
        accessibilityLabel={t('player.label', { name })}
      />

      {!showVideo && snapshot ? (
        <StateOverlay
          name={name}
          snapshot={snapshot}
          screen={screen}
          controller={watch?.controller ?? null}
          onClose={close}
        />
      ) : null}
      {showVideo && snapshot?.unstable ? (
        <UnstableBadge label={t('player.unstable')} lowered={controls} />
      ) : null}
      {screen === 'reconnecting' && source ? (
        <View style={styles.reconnecting} pointerEvents={NO_TOUCH}>
          <ActivityIndicator color={WHITE} />
        </View>
      ) : null}

      {controls || !showVideo ? (
        <SafeAreaView style={styles.top} edges={TOP_EDGES} pointerEvents={PASS_TOUCH}>
          <View style={styles.bar}>
            <Pressable
              accessibilityRole="button"
              onPress={close}
              hitSlop={12}
              style={[styles.chip, styles.chipBack]}
            >
              <CaretLeft size={16} color={WHITE} />
              <Text style={styles.chipText}>{t('common.back')}</Text>
            </Pressable>
            <Text style={styles.name} numberOfLines={1}>
              {snapshot?.stream
                ? `${name} · ${snapshot.stream.source.label}`
                : t('mobile.player.title')}
            </Text>
          </View>
        </SafeAreaView>
      ) : null}

      {controls && showVideo && snapshot ? (
        <SafeAreaView style={styles.bottom} edges={BOTTOM_EDGES} pointerEvents={PASS_TOUCH}>
          <View style={styles.bar}>
            <Chip
              label={
                volume.muted || volume.volume === 0
                  ? t('mobile.player.unmute')
                  : t('mobile.player.mute')
              }
              onPress={() => {
                reveal();
                setVolume((v) => ({ ...v, muted: !v.muted }));
              }}
            />
            <Chip
              label="−"
              accessibilityLabel={t('mobile.player.volumeDown')}
              onPress={() => {
                reveal();
                setVolume((v) => stepVolume(v, -1));
              }}
            />
            <Text style={styles.small}>
              {volume.muted ? t('player.muted') : `${Math.round(volume.volume * 100)}%`}
            </Text>
            <Chip
              label="+"
              accessibilityLabel={t('mobile.player.volumeUp')}
              onPress={() => {
                reveal();
                setVolume((v) => stepVolume(v, 1));
              }}
            />
            <View style={styles.spacer} />
            {qualityOptions(snapshot.layers).length > 0 ? (
              <Chip
                label={qualityLabel(snapshot, t('player.quality.auto'))}
                onPress={() => setMenu(true)}
              />
            ) : null}
            <Chip
              label={t('mobile.player.stats')}
              active={stats}
              onPress={() => setStats((s) => !s)}
            />
            <Chip
              label={landscape ? t('mobile.player.portrait') : t('mobile.player.landscape')}
              onPress={() => {
                reveal();
                rotate(TOGGLE_ROTATION);
              }}
            />
          </View>
        </SafeAreaView>
      ) : null}

      {stats && snapshot ? <StatsPanel snapshot={snapshot} /> : null}

      <StillWatching
        idle={snapshot?.idle ?? null}
        onContinue={() => watch.controller.confirmWatching()}
        onStop={close}
      />

      <QualityMenu
        visible={menu}
        snapshot={snapshot}
        accent={colors.primary}
        onPick={(q) => {
          if (snapshot?.source) watch?.controller.setQuality(q);
          setMenu(false);
        }}
        onClose={() => setMenu(false)}
      />
    </View>
  );
}

/** Brake 6: "Still watching?", with the seconds left before watching stops. */
function StillWatching({
  idle,
  onContinue,
  onStop,
}: {
  idle: IdleState | null;
  onContinue: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const asking = idle?.kind === 'asking' ? idle : null;
  return (
    // The back button is an answer too: someone is there.
    <Modal visible={asking !== null} transparent animationType={FADE} onRequestClose={onContinue}>
      <View style={styles.modalScrim}>
        <View style={styles.menu}>
          <Text style={styles.menuTitle}>{t('player.stillWatching.title')}</Text>
          {asking ? <Countdown deadline={asking.deadline} /> : null}
          <View style={styles.actions}>
            <Chip label={t('player.stillWatching.continue')} onPress={onContinue} active />
            <Chip label={t('player.stillWatching.stop')} onPress={onStop} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** The seconds left to answer; mounted (and ticking) only while the question is open. */
function Countdown({ deadline }: { deadline: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return <Text style={styles.stateText}>{t('player.stillWatching.description', { seconds })}</Text>;
}

/** "Automatic (1080p60)" while on Automatic, the fixed layer's name otherwise. */
function qualityLabel(snapshot: WatchSnapshot<RnSource>, auto: string): string {
  const current = layerOf(snapshot.layers, snapshot.layer);
  if (snapshot.quality === 'auto') return current ? `${auto} · ${layerLabel(current)}` : auto;
  const fixed = layerOf(snapshot.layers, snapshot.quality);
  return fixed ? layerLabel(fixed) : auto;
}

function Chip({
  label,
  onPress,
  active = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      hitSlop={6}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={styles.chipText}>{label}</Text>
    </Pressable>
  );
}

function QualityMenu({
  visible,
  snapshot,
  accent,
  onPick,
  onClose,
}: {
  visible: boolean;
  snapshot: WatchSnapshot<RnSource> | null;
  accent: string;
  onPick: (quality: 'auto' | 'f' | 'h' | 'q') => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const options = useMemo(() => qualityOptions(snapshot?.layers ?? []), [snapshot?.layers]);
  return (
    <Modal visible={visible} transparent animationType={FADE} onRequestClose={onClose}>
      <Pressable style={styles.modalScrim} onPress={onClose}>
        <View style={styles.menu}>
          <Text style={styles.menuTitle}>{t('mobile.player.quality')}</Text>
          {options.map((option) => {
            const selected = snapshot?.quality === option.value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => onPick(option.value)}
                style={styles.menuItem}
              >
                <Text
                  style={[
                    styles.menuText,
                    selected && { color: accent, fontFamily: font.semibold },
                  ]}
                >
                  {option.label ?? t('player.quality.auto')}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Pressable>
    </Modal>
  );
}

function StatsPanel({ snapshot }: { snapshot: WatchSnapshot<RnSource> }) {
  const { t } = useTranslation();
  const lines = statsLines(snapshot.sample, {
    layer: (() => {
      const l = layerOf(snapshot.layers, snapshot.layer);
      return l ? layerLabel(l) : null;
    })(),
    ttffMs: snapshot.ttffMs,
    codec: snapshot.codec ?? null,
  });
  return (
    <SafeAreaView style={styles.stats} edges={STATS_EDGES} pointerEvents={NO_TOUCH}>
      <View style={styles.statsBox}>
        <Text style={styles.menuTitle}>{t('player.stats.title')}</Text>
        {lines.length === 0 ? <Text style={styles.small}>{t('player.stats.waiting')}</Text> : null}
        {lines.map((line) => (
          <Text key={line.key} style={styles.small}>
            {t(`player.stats.${line.key}`)}: {line.value}
          </Text>
        ))}
        {snapshot.sample ? (
          <Text style={styles.small}>
            {t('player.stats.frames')}:{' '}
            {t('player.stats.framesValue', {
              decoded: snapshot.sample.framesDecoded,
              freezes: snapshot.sample.freezeCount,
              lost: snapshot.sample.packetsLost,
            })}
          </Text>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const SCREEN_KEYS: Partial<Record<ScreenKind, string>> = {
  connecting: 'connecting',
  paused: 'paused',
  curtain: 'curtain',
  reconnecting: 'reconnecting',
  ended: 'ended',
  noPermission: 'noPermission',
  roomExpired: 'roomExpired',
  helperOffline: 'helperOffline',
  helperOutdated: 'helperOutdated',
  full: 'full',
};

/** What shows instead of the video: every state of the watch has words of its own. */
function StateOverlay({
  name,
  snapshot,
  screen,
  controller,
  onClose,
}: {
  name: string;
  snapshot: WatchSnapshot<RnSource>;
  screen: ScreenKind;
  controller: WatchController<RnSource> | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const key = SCREEN_KEYS[screen];
  const released = snapshot.presence === 'released';
  const busy = screen === 'connecting' || screen === 'reconnecting';
  return (
    <View style={styles.center} pointerEvents={PASS_TOUCH}>
      {busy && !released ? <ActivityIndicator color={WHITE} size={LARGE} /> : null}
      <Text style={styles.stateTitle}>
        {released
          ? t('mobile.player.background.title')
          : key
            ? t(`player.screen.${key}.title`, { name })
            : ''}
      </Text>
      <Text style={styles.stateText}>
        {released
          ? t('mobile.player.background.description')
          : key
            ? t(`player.screen.${key}.description`, { name })
            : ''}
      </Text>
      {screen === 'full' && !released && controller ? (
        <QueueActions snapshot={snapshot} controller={controller} />
      ) : null}
      {screen === 'ended' ||
      screen === 'noPermission' ||
      screen === 'roomExpired' ||
      screen === 'helperOffline' ||
      screen === 'helperOutdated' ? (
        <Chip label={t('player.backToRoom')} onPress={onClose} />
      ) : null}
    </View>
  );
}

/** The slot queue (PROTOCOL 7.3): join, wait in line, take the offered slot. */
function QueueActions({
  snapshot,
  controller,
}: {
  snapshot: WatchSnapshot<RnSource>;
  controller: WatchController<RnSource>;
}) {
  const { t } = useTranslation();
  const { access, viewers } = snapshot;
  const watch = {
    join: () => controller.joinQueue(),
    leave: () => controller.leaveQueue(),
    accept: () => controller.acceptOffer(),
  };
  const slots = viewers ? (
    <Text style={styles.stateText}>
      {t('player.queue.slots', { used: viewers.used, limit: viewers.limit })}
    </Text>
  ) : null;
  if (access?.kind === 'offer') {
    return (
      <View style={styles.actions}>
        <Text style={styles.stateTitle}>{t('player.queue.offer')}</Text>
        <Chip label={t('player.queue.accept')} onPress={watch.accept} active />
        <Chip label={t('player.queue.decline')} onPress={watch.leave} />
      </View>
    );
  }
  const queue = access?.kind === 'full' ? access.queue : null;
  if (queue === 'joining') {
    return (
      <View style={styles.actions}>
        {slots}
        <ActivityIndicator color={WHITE} />
        <Text style={styles.stateText}>{t('player.queue.joining')}</Text>
      </View>
    );
  }
  if (queue) {
    return (
      <View style={styles.actions}>
        {slots}
        <Text style={styles.stateText}>
          {t('player.queue.position', { position: queue.position, length: queue.length })}
        </Text>
        <Chip label={t('player.queue.leave')} onPress={watch.leave} />
      </View>
    );
  }
  return (
    <View style={styles.actions}>
      {slots}
      <Chip label={t('player.queue.join')} onPress={watch.join} active />
      <Text style={styles.stateText}>{t('player.queue.joinHint')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  video: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  top: { position: 'absolute', top: 0, left: 0, right: 0 },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: SCRIM },
  spacer: { flex: 1 },
  name: { flex: 1, color: WHITE, fontFamily: font.semibold, fontSize: 15 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.4)',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  chipBack: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chipActive: { backgroundColor: 'rgba(140,178,120,0.45)' },
  chipText: { color: WHITE, fontFamily: font.medium, fontSize: 14 },
  small: { color: WHITE, fontFamily: font.regular, fontSize: 13 },
  badge: { position: 'absolute', top: 0, right: 0, alignItems: 'flex-end' },
  badgeLow: { top: 52 },
  badgeIcon: {
    margin: 10,
    padding: 6,
    borderRadius: 8,
    backgroundColor: SCRIM,
  },
  badgeTip: {
    marginHorizontal: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: SCRIM,
  },
  reconnecting: {
    position: 'absolute',
    top: 64,
    alignSelf: 'center',
    backgroundColor: SCRIM,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  stateTitle: { color: WHITE, fontFamily: font.semibold, fontSize: 20, textAlign: 'center' },
  stateText: {
    color: 'rgba(251,251,249,0.75)',
    fontFamily: font.regular,
    fontSize: 15,
    textAlign: 'center',
  },
  actions: { alignItems: 'center', gap: 10 },
  stats: { position: 'absolute', top: 56, right: 0 },
  statsBox: { margin: 8, padding: 10, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.7)', gap: 2 },
  modalScrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  menu: { minWidth: 240, borderRadius: 12, backgroundColor: '#1d1d16', padding: 8 },
  menuTitle: { color: WHITE, fontFamily: font.semibold, fontSize: 14, padding: 8 },
  menuItem: { paddingHorizontal: 12, paddingVertical: 12 },
  menuText: { color: WHITE, fontFamily: font.regular, fontSize: 16 },
});
