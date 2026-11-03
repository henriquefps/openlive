// SPDX-License-Identifier: AGPL-3.0-only
import type {
  MediaTrackLike,
  SessionVoice,
  VoiceClient,
  VoiceClientState,
  VoiceSignal,
} from '@openlive/client';

// The voice client of a room with what a phone adds around it (A3): before the microphone opens,
// the microphone permission and the call (foreground service and notification, communication audio
// mode, voice audio device, apps/mobile/src/voice-native); while in voice, the notification's
// Mute / Leave buttons act on the client and its mute shows in the notification; when the voice
// ends, however it ends (leave, a moderator's kick, the room closed, the service killed), the
// call on the phone ends with it and the audio goes back to media (or is released). The shared
// VoiceClient stays as the web has it; this wraps it as the session's SessionVoice.

/** The phone-side call (voice-native/index.ts); injected so the rules are tested without a phone. */
export interface PhoneCall {
  requestMicPermission(): Promise<'granted' | 'denied' | 'blocked'>;
  startVoiceSession(options: {
    roomName: string;
    serverName: string;
    serverAddress?: string;
    muted: boolean;
    microphone: boolean;
  }): Promise<unknown>;
  stopVoiceSession(): void;
  /** Mute shown in the notification (its button reads Unmute). */
  setNotificationMuted(muted: boolean): void;
  onNotificationAction(listener: (action: 'mute' | 'unmute' | 'leave') => void): () => void;
  /** The call ended on its own: the app was closed, or the system stopped the service. */
  onSessionEnded(listener: () => void): () => void;
}

export interface PhoneVoiceOptions<T extends MediaTrackLike> {
  client: VoiceClient<T>;
  signal: VoiceSignal;
  call: PhoneCall;
  /** Where the call is: shown in the notification. */
  describe: () => { roomName: string; serverName: string; serverAddress?: string };
}

/** Why joining did not start (the voice stays off). */
export type JoinFailure = 'service_failed' | 'unsupported';

export interface PhoneVoiceState extends VoiceClientState {
  /** The permission and the call are being set up: the click was heard, the client not joining yet. */
  preparing: boolean;
  /** The phone could not start the call. */
  joinFailure: JoinFailure | null;
  /** The microphone permission is blocked: only the app's settings can allow it. */
  micBlocked: boolean;
}

export class PhoneVoice<T extends MediaTrackLike = MediaTrackLike> implements SessionVoice {
  private preparing = false;
  private joinFailure: JoinFailure | null = null;
  private micBlocked = false;
  private callOn = false;
  private state: PhoneVoiceState;
  private readonly listeners = new Set<() => void>();
  private unsubscribers: (() => void)[] = [];
  private started = false;

  constructor(private readonly options: PhoneVoiceOptions<T>) {
    this.state = this.build();
  }

  getState = (): PhoneVoiceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get client(): VoiceClient<T> {
    return this.options.client;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { client, call } = this.options;
    client.start();
    this.unsubscribers.push(
      client.subscribe(() => this.onClient()),
      call.onNotificationAction((action) => {
        if (action === 'leave') this.leave();
        else client.setMuted(action === 'mute');
      }),
      // The system ended the call (the app swiped away, the service stopped): leave voice too.
      // Not when it is this class that just stopped the call.
      call.onSessionEnded(() => {
        if (this.callOn || client.getState().phase !== 'idle') this.leave();
      }),
    );
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.options.client.stop();
    this.endCall();
  }

  /** The room's voice join: permission, the call on the phone, then the client joins. */
  async join(): Promise<void> {
    const { client, signal, call, describe } = this.options;
    if (this.preparing || client.getState().phase !== 'idle') return;
    this.preparing = true;
    this.joinFailure = null;
    this.micBlocked = false;
    this.changed();
    try {
      // Someone who may not speak joins to listen: no microphone, no permission.
      let microphone = false;
      if (signal.getVoice().canSpeak) {
        const permission = await call.requestMicPermission();
        microphone = permission === 'granted';
        this.micBlocked = permission === 'blocked';
      }
      try {
        await call.startVoiceSession({ ...describe(), muted: client.getState().muted, microphone });
        this.callOn = true;
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        // A call that is still up (a quick leave and join) is reused.
        if (code === 'already_active') this.callOn = true;
        else {
          this.joinFailure = code === 'unsupported' ? 'unsupported' : 'service_failed';
          return;
        }
      }
      await client.join();
      // The client did not go in (a leave came meanwhile): the call must not stay up.
      if (client.getState().phase === 'idle') this.endCall();
    } finally {
      this.preparing = false;
      this.changed();
    }
  }

  leave(): void {
    this.options.client.leave();
    this.endCall();
    this.changed();
  }

  /** The microphone was blocked and the person went to the settings: ask again on the next join. */
  clearFailure(): void {
    this.joinFailure = null;
    this.micBlocked = false;
    this.changed();
  }

  private onClient(): void {
    const { client, call } = this.options;
    const s = client.getState();
    if (s.phase === 'idle') this.endCall();
    else if (this.callOn) call.setNotificationMuted(s.muted);
    this.changed();
  }

  private endCall(): void {
    if (!this.callOn) return;
    this.callOn = false;
    this.options.call.stopVoiceSession();
  }

  private build(): PhoneVoiceState {
    return {
      ...this.options.client.getState(),
      preparing: this.preparing,
      joinFailure: this.joinFailure,
      micBlocked: this.micBlocked,
    };
  }

  private changed(): void {
    this.state = this.build();
    for (const listener of [...this.listeners]) listener();
  }
}
