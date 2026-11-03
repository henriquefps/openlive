// SPDX-License-Identifier: AGPL-3.0-only
import { requireOptionalNativeModule } from 'expo';
import { Alert, Linking, PermissionsAndroid, Platform, type Permission } from 'react-native';
import i18n from '../i18n/index.ts';
import type {
  ActiveRoute,
  NativeEvent,
  NativeVoice,
  NotificationAction,
  PermissionResult,
  PermissionsApi,
  RouteInfo,
  RoutePreference,
  ServiceOptions,
  VoiceDevice,
} from './session.ts';

// The binding of the controller to the phone: the OpenliveVoice native module (Android) and the
// system's permission dialogs.

interface Subscription {
  remove(): void;
}

interface Native {
  startService(options: ServiceOptions): Promise<void>;
  updateService(options: ServiceOptions): void;
  stopService(): void;
  useVoiceDevice(): VoiceDevice;
  useMediaDevice(): void;
  setRoute(route: RoutePreference): void;
  clearRoute(): void;
  getRoute(): RouteInfo;
  startMicMonitor(): void;
  stopMicMonitor(): void;
  addListener(
    event: 'onNotificationAction',
    l: (e: { action: NotificationAction }) => void,
  ): Subscription;
  addListener(
    event: 'onSessionEnded',
    l: (e: { reason: 'task_removed' | 'service_stopped' }) => void,
  ): Subscription;
  addListener(
    event: 'onRouteChange',
    l: (e: { active: ActiveRoute; available: ActiveRoute[] }) => void,
  ): Subscription;
  addListener(event: 'onMicLevel', l: (e: { level: number }) => void): Subscription;
}

const module =
  Platform.OS === 'android' ? requireOptionalNativeModule<Native>('OpenliveVoice') : null;

export const nativeVoice: NativeVoice | null = module
  ? {
      startService: (options) => module.startService(options),
      updateService: (options) => module.updateService(options),
      stopService: () => module.stopService(),
      useVoiceDevice: () => module.useVoiceDevice(),
      useMediaDevice: () => module.useMediaDevice(),
      setRoute: (route) => module.setRoute(route),
      clearRoute: () => module.clearRoute(),
      getRoute: () => module.getRoute(),
      startMicMonitor: () => module.startMicMonitor(),
      stopMicMonitor: () => module.stopMicMonitor(),
      onEvent: (listener: (event: NativeEvent) => void) => {
        const subs = [
          module.addListener('onNotificationAction', (e) =>
            listener({ type: 'action', action: e.action }),
          ),
          module.addListener('onSessionEnded', (e) =>
            listener({ type: 'ended', reason: e.reason }),
          ),
          module.addListener('onRouteChange', (e) =>
            listener({ type: 'route', route: { active: e.active, available: e.available } }),
          ),
          module.addListener('onMicLevel', (e) => listener({ type: 'level', level: e.level })),
        ];
        return () => subs.forEach((sub) => sub.remove());
      },
    }
  : null;

const MIC = 'android.permission.RECORD_AUDIO' as Permission;
const NOTIFICATIONS = 'android.permission.POST_NOTIFICATIONS' as Permission;
const BLUETOOTH = 'android.permission.BLUETOOTH_CONNECT' as Permission;

const result = (r: string): PermissionResult =>
  r === PermissionsAndroid.RESULTS.GRANTED
    ? 'granted'
    : r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
      ? 'blocked'
      : 'denied';

/** Dialogs and permissions of Android; on other platforms nothing is granted. */
export const androidPermissions: PermissionsApi = {
  isMicGranted: async () => Platform.OS === 'android' && (await PermissionsAndroid.check(MIC)),

  requestMic: async () =>
    Platform.OS === 'android' ? result(await PermissionsAndroid.request(MIC)) : 'denied',

  // Before Android 13 notifications need no permission.
  requestNotifications: async () => {
    if (Platform.OS !== 'android') return 'denied';
    if (typeof Platform.Version === 'number' && Platform.Version < 33) return 'granted';
    if (await PermissionsAndroid.check(NOTIFICATIONS)) return 'granted';
    return result(await PermissionsAndroid.request(NOTIFICATIONS));
  },

  requestBluetooth: async () => {
    if (Platform.OS !== 'android') return 'denied';
    if (typeof Platform.Version === 'number' && Platform.Version < 31) return 'granted';
    if (await PermissionsAndroid.check(BLUETOOTH)) return 'granted';
    return result(await PermissionsAndroid.request(BLUETOOTH));
  },

  explainMic: () =>
    new Promise<boolean>((resolve) => {
      Alert.alert(
        i18n.t('voice.permission.title'),
        i18n.t('voice.permission.message'),
        [
          {
            text: i18n.t('voice.permission.notNow'),
            style: 'cancel',
            onPress: () => resolve(false),
          },
          { text: i18n.t('voice.permission.continue'), onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      );
    }),

  openSettings: () => void Linking.openSettings(),
};

/** The system will not ask again: says so and offers the app's settings. */
export function explainBlockedMic(): void {
  Alert.alert(i18n.t('voice.permission.title'), i18n.t('voice.permission.blockedMessage'), [
    { text: i18n.t('voice.permission.notNow'), style: 'cancel' },
    { text: i18n.t('voice.permission.openSettings'), onPress: androidPermissions.openSettings },
  ]);
}
