// SPDX-License-Identifier: AGPL-3.0-only
import type { VoiceClient, VoiceClientState, VoiceSignal } from '@openlive/client';
import { describe, expect, it } from 'vitest';
import { AudioModeController, type NativeAudio } from '../src/audio/mode.ts';
import { PhoneVoice, type PhoneCall } from '../src/voice/phone-voice.ts';
import {
  type NativeEvent,
  type NativeVoice,
  type PermissionResult,
  type PermissionsApi,
  type RouteInfo,
  VoiceSessionController,
} from '../src/voice-native/session.ts';

// The phone around the shared voice client: the order of permission, call and join; the
// notification's buttons; and how the audio mode follows the call (join, leave, a moderator's
// kick, the room closing, watching a stream while in voice).

const IDLE: VoiceClientState = {
  phase: 'idle',
  muted: false,
  deafened: false,
  serverMuted: false,
  pushToTalk: false,
  pushToTalkKey: 'KeyV',
  pttPressed: false,
  transmitting: false,
  micError: null,
  error: null,
  removed: null,
  speaking: {},
  volumes: {},
  inputs: [],
  outputs: [],
  inputId: '',
  outputId: '',
  canPickOutput: false,
  voiceSinkId: null,
};

/** The shared client's surface PhoneVoice uses, scripted by the test. */
function fakeClient(calls: string[]) {
  let state = IDLE;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<VoiceClientState>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };
  const client = {
    start: () => void calls.push('client.start'),
    stop: () => {
      calls.push('client.stop');
      if (state.phase !== 'idle') set({ phase: 'idle' });
    },
    getState: () => state,
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    join: async () => {
      calls.push('client.join');
      set({ phase: 'joining' });
      set({ phase: 'joined' });
    },
    leave: () => {
      calls.push('client.leave');
      if (state.phase !== 'idle') set({ phase: 'idle', muted: false });
    },
    setMuted: (muted: boolean) => {
      calls.push(`client.setMuted ${muted}`);
      set({ muted });
    },
  };
  return { client: client as unknown as VoiceClient, set };
}

function setup(opts: { canSpeak?: boolean; mic?: PermissionResult; startFails?: boolean } = {}) {
  const calls: string[] = [];
  let emit: (event: NativeEvent) => void = () => undefined;
  const route: RouteInfo = { active: 'speaker', available: ['speaker'] };
  const native: NativeVoice = {
    startService: async (o) => {
      calls.push(`service start mic=${o.microphone} muted=${o.muted}`);
      if (opts.startFails) throw new Error('not allowed');
    },
    updateService: (o) => void calls.push(`service update muted=${o.muted}`),
    stopService: () => void calls.push('service stop'),
    useVoiceDevice: () => ({ hardwareAec: true, hardwareNs: true, swapped: true }),
    useMediaDevice: () => void calls.push('device media'),
    setRoute: () => undefined,
    clearRoute: () => undefined,
    getRoute: () => route,
    startMicMonitor: () => undefined,
    stopMicMonitor: () => undefined,
    onEvent: (listener) => {
      emit = listener;
      return () => undefined;
    },
  };
  let granted = false;
  const permissions: PermissionsApi = {
    isMicGranted: async () => granted,
    requestMic: async () => {
      calls.push('mic requested');
      const result = opts.mic ?? 'granted';
      granted = result === 'granted';
      return result;
    },
    requestNotifications: async () => 'granted',
    requestBluetooth: async () => 'granted',
    explainMic: async () => true,
    openSettings: () => undefined,
  };
  const nativeAudio: NativeAudio = {
    setMode: (mode) => void calls.push(`audio ${mode}`),
    release: () => void calls.push('audio release'),
    onFocusChange: () => () => undefined,
  };
  const audio = new AudioModeController(nativeAudio);
  const controller = new VoiceSessionController(native, permissions, audio);
  // The same adapter host.ts builds from voice-native's functions.
  const call: PhoneCall = {
    requestMicPermission: () => controller.requestMicPermission(async () => true),
    startVoiceSession: (o) => controller.startVoiceSession(o),
    stopVoiceSession: () => controller.stopVoiceSession(),
    setNotificationMuted: (m) => controller.setMuted(m),
    onNotificationAction: controller.onNotificationAction,
    onSessionEnded: (l) => controller.onSessionEnded(() => l()),
  };
  const { client, set } = fakeClient(calls);
  const signal = {
    getVoice: () => ({ canSpeak: opts.canSpeak ?? true }),
  } as unknown as VoiceSignal;
  const phone = new PhoneVoice({
    client,
    signal,
    call,
    describe: () => ({ roomName: 'general', serverName: 'Home', serverAddress: 'x.example' }),
  });
  phone.start();
  return { calls, phone, client, set, audio, controller, emit: (e: NativeEvent) => emit(e) };
}

describe('joining', () => {
  it('asks for the microphone, starts the call, then joins', async () => {
    const t = setup();
    await t.phone.join();
    expect(t.calls).toEqual([
      'client.start',
      'mic requested',
      'audio communication',
      'service start mic=true muted=false',
      'client.join',
    ]);
    expect(t.phone.getState().phase).toBe('joined');
    expect(t.audio.mode).toBe('communication');
    expect(t.controller.getSnapshot().state).toBe('active');
  });

  it('shows the click was heard while the permission dialog is up', async () => {
    const t = setup();
    const seen: boolean[] = [];
    t.phone.subscribe(() => seen.push(t.phone.getState().preparing));
    await t.phone.join();
    expect(seen[0]).toBe(true);
    expect(t.phone.getState().preparing).toBe(false);
  });

  it('listen-only without the permission dialog for someone who may not speak', async () => {
    const t = setup({ canSpeak: false });
    await t.phone.join();
    expect(t.calls).not.toContain('mic requested');
    expect(t.calls).toContain('service start mic=false muted=false');
    expect(t.calls).toContain('client.join');
  });

  it('a blocked microphone still joins, listening only, and says it is blocked', async () => {
    const t = setup({ mic: 'blocked' });
    await t.phone.join();
    expect(t.calls).toContain('service start mic=false muted=false');
    expect(t.phone.getState()).toMatchObject({ phase: 'joined', micBlocked: true });
  });

  it('a denied microphone joins listening only (the client reports the error)', async () => {
    const t = setup({ mic: 'denied' });
    await t.phone.join();
    expect(t.calls).toContain('service start mic=false muted=false');
    expect(t.phone.getState().phase).toBe('joined');
    expect(t.phone.getState().micBlocked).toBe(false);
  });

  it('does not join when the phone cannot start the call, and leaves audio alone', async () => {
    const t = setup({ startFails: true });
    await t.phone.join();
    expect(t.calls).not.toContain('client.join');
    expect(t.phone.getState()).toMatchObject({ phase: 'idle', joinFailure: 'service_failed' });
    expect(t.audio.mode).toBeNull();
  });

  it('a second join while joined or preparing does nothing', async () => {
    const t = setup();
    const first = t.phone.join();
    await t.phone.join();
    await first;
    await t.phone.join();
    expect(t.calls.filter((c) => c === 'client.join')).toHaveLength(1);
  });
});

describe('audio mode through the call', () => {
  it('leaving goes back to nothing held when nothing is watched', async () => {
    const t = setup();
    await t.phone.join();
    t.phone.leave();
    expect(t.calls).toContain('service stop');
    expect(t.calls).toContain('audio release');
    expect(t.audio.mode).toBeNull();
    expect(t.controller.getSnapshot().state).toBe('idle');
  });

  it('a moderator removing you ends the call and the audio mode', async () => {
    const t = setup();
    await t.phone.join();
    // The shared client goes idle by itself (kicked, room closed, voice turned off).
    t.set({ phase: 'idle', removed: 'kicked' });
    expect(t.calls.filter((c) => c === 'service stop')).toHaveLength(1);
    expect(t.audio.mode).toBeNull();
    expect(t.phone.getState().removed).toBe('kicked');
  });

  it('watching while in voice keeps communication mode and plays through the same output', async () => {
    const t = setup();
    await t.phone.join();
    t.calls.length = 0;
    t.audio.setAudioMode('media'); // the player opens
    expect(t.audio.mode).toBe('communication');
    expect(t.calls).toEqual([]);
    t.audio.releaseMedia(); // the player closes: voice still holds the audio
    expect(t.audio.mode).toBe('communication');
  });

  it('leaving voice while a stream is watched returns the player to media', async () => {
    const t = setup();
    t.audio.setAudioMode('media'); // watching first
    await t.phone.join();
    expect(t.audio.mode).toBe('communication');
    t.phone.leave();
    expect(t.audio.mode).toBe('media');
    expect(t.calls.at(-1)).toBe('audio media');
    expect(t.calls.filter((c) => c === 'client.leave')).toHaveLength(1);
  });

  it('a stream opened during voice and still watched after it ends plays as media', async () => {
    const t = setup();
    await t.phone.join();
    t.audio.setAudioMode('media');
    t.set({ phase: 'idle' }); // kicked
    expect(t.audio.mode).toBe('media');
  });

  it('closing the player during voice and then leaving releases the audio', async () => {
    const t = setup();
    t.audio.setAudioMode('media');
    await t.phone.join();
    t.audio.releaseMedia();
    t.phone.leave();
    expect(t.audio.mode).toBeNull();
  });
});

describe('the notification', () => {
  it('Mute and Unmute act on the client; Leave leaves', async () => {
    const t = setup();
    await t.phone.join();
    t.emit({ type: 'action', action: 'mute' });
    expect(t.client.getState().muted).toBe(true);
    t.emit({ type: 'action', action: 'unmute' });
    expect(t.client.getState().muted).toBe(false);
    t.emit({ type: 'action', action: 'leave' });
    expect(t.phone.getState().phase).toBe('idle');
    expect(t.controller.getSnapshot().state).toBe('idle');
  });

  it('shows the client mute (a tap in the app) as the button reading Unmute', async () => {
    const t = setup();
    await t.phone.join();
    t.client.setMuted(true);
    expect(t.calls).toContain('service update muted=true');
  });

  it('the service being stopped by the system leaves voice', async () => {
    const t = setup();
    await t.phone.join();
    t.emit({ type: 'ended', reason: 'service_stopped' });
    expect(t.phone.getState().phase).toBe('idle');
    expect(t.calls).toContain('client.leave');
  });

  it('the app swiped away leaves voice', async () => {
    const t = setup();
    await t.phone.join();
    t.emit({ type: 'ended', reason: 'task_removed' });
    expect(t.phone.getState().phase).toBe('idle');
  });
});
