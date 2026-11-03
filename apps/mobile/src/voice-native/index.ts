// SPDX-License-Identifier: AGPL-3.0-only
import { audio } from '../audio/index.ts';
import i18n from '../i18n/index.ts';
import { androidPermissions, explainBlockedMic, nativeVoice } from './native.ts';
import {
  type NotificationTexts,
  type PermissionResult,
  type StartOptions,
  type StartResult,
  VoiceSessionController,
} from './session.ts';

export {
  type ActiveRoute,
  type EndReason,
  type NotificationAction,
  type PermissionResult,
  type RoutePreference,
  type SessionState,
  type Snapshot,
  type StartOptions,
  type StartResult,
  VoiceSessionError,
  type VoiceErrorCode,
} from './session.ts';

// What A3's voice screens call to keep a call alive on the phone (see apps/mobile/README.md,
// "Voice on the phone"). `voice` is the one session.
export const voice = new VoiceSessionController(nativeVoice, androidPermissions, audio);

/** The notification's texts in the app's language. */
export function notificationTexts(roomName: string): Partial<NotificationTexts> {
  return {
    title: i18n.t('voice.notification.title', { room: roomName }),
    mute: i18n.t('voice.notification.mute'),
    unmute: i18n.t('voice.notification.unmute'),
    leave: i18n.t('voice.notification.leave'),
    channel: i18n.t('voice.notification.channel'),
  };
}

/**
 * Starts the foreground service, the notification ("In voice in #room", with mute and leave),
 * the call audio mode and the voice audio device. `texts` default to the app's language.
 */
export const startVoiceSession = (options: StartOptions): Promise<StartResult> =>
  voice.startVoiceSession({
    ...options,
    texts: { ...notificationTexts(options.roomName), ...options.texts },
  });

/** Ends it: service and notification gone, audio back to media (or released). Safe to repeat. */
export const stopVoiceSession = (): void => voice.stopVoiceSession();

/** The notification's Mute, Unmute and Leave buttons. The voice client acts on them. */
export const onNotificationAction = voice.onNotificationAction;

/** Speaker, earpiece or automatic (headset first, else speaker). */
export const setRoute = (route: Parameters<typeof voice.setRoute>[0]): void =>
  voice.setRoute(route);

/**
 * Tells why the microphone is needed, then asks. When the system will not ask again (`blocked`)
 * it says so and offers the app's settings.
 */
export async function requestMicPermission(): Promise<PermissionResult> {
  const result = await voice.requestMicPermission();
  if (result === 'blocked') explainBlockedMic();
  return result;
}

export const requestNotificationPermission = voice.requestNotificationPermission;
export const openAppSettings = voice.openSettings;
