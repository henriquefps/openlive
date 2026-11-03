// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioModeController, type NativeAudio } from '../src/audio/mode.ts';
import {
  LEAVE_GRACE_MS,
  type NativeEvent,
  type NativeVoice,
  type PermissionResult,
  type PermissionsApi,
  type RouteInfo,
  type ServiceOptions,
  VoiceSessionController,
  VoiceSessionError,
} from '../src/voice-native/session.ts';

// The phone side of a voice call: which native calls a session makes, in what order, and what the
// notification's buttons, a swiped-away app and a failed start do to it.

function setup(opts: { mic?: boolean; micResult?: PermissionResult; startFails?: boolean } = {}) {
  const calls: string[] = [];
  let emit: (event: NativeEvent) => void = () => undefined;
  let route: RouteInfo = { active: 'speaker', available: ['speaker', 'earpiece'] };
  let release: () => void = () => undefined;
  const gate = { hold: false };
  const native: NativeVoice = {
    startService: async (o: ServiceOptions) => {
      calls.push(`startService ${o.title} | ${o.text} | muted=${o.muted} mic=${o.microphone}`);
      if (opts.startFails) throw new Error('not allowed');
      if (gate.hold) await new Promise<void>((resolve) => (release = resolve));
    },
    updateService: (o) => void calls.push(`updateService muted=${o.muted}`),
    stopService: () => void calls.push('stopService'),
    useVoiceDevice: () => {
      calls.push('useVoiceDevice');
      return { hardwareAec: true, hardwareNs: false, swapped: true };
    },
    useMediaDevice: () => void calls.push('useMediaDevice'),
    setRoute: (r) => void calls.push(`setRoute ${r}`),
    clearRoute: () => void calls.push('clearRoute'),
    getRoute: () => route,
    startMicMonitor: () => void calls.push('startMicMonitor'),
    stopMicMonitor: () => void calls.push('stopMicMonitor'),
    onEvent: (listener) => {
      emit = listener;
      return () => {
        emit = () => undefined;
      };
    },
  };
  let granted = opts.mic ?? true;
  const permissions: PermissionsApi = {
    isMicGranted: async () => granted,
    requestMic: async () => {
      calls.push('requestMic');
      const result = opts.micResult ?? 'granted';
      granted = result === 'granted';
      return result;
    },
    requestNotifications: async () => {
      calls.push('requestNotifications');
      return 'granted';
    },
    requestBluetooth: async () => {
      calls.push('requestBluetooth');
      return 'denied';
    },
    explainMic: async () => {
      calls.push('explainMic');
      return true;
    },
    openSettings: () => void calls.push('openSettings'),
  };
  const nativeAudio: NativeAudio = {
    setMode: (mode) => void calls.push(`audio ${mode}`),
    release: () => void calls.push('audio release'),
    onFocusChange: () => () => undefined,
  };
  const audio = new AudioModeController(nativeAudio);
  const session = new VoiceSessionController(native, permissions, audio);
  return {
    calls,
    native,
    audio,
    session,
    emit: (event: NativeEvent) => emit(event),
    setRoute: (r: RouteInfo) => (route = r),
    hold: () => (gate.hold = true),
    release: () => release(),
  };
}

const START = { roomName: 'general', serverName: 'Home', serverAddress: 'openlive.example.com' };

describe('startVoiceSession', () => {
  it('sets up audio, device, service and route in that order', async () => {
    const { calls, session } = setup();
    const result = await session.startVoiceSession(START);
    expect(calls).toEqual([
      'requestNotifications',
      'requestBluetooth',
      'audio communication',
      'useVoiceDevice',
      'startService In voice in #general | Home · openlive.example.com | muted=false mic=true',
      'setRoute auto',
    ]);
    expect(result).toEqual({
      device: { hardwareAec: true, hardwareNs: false, swapped: true },
      notifications: true,
    });
    expect(session.getSnapshot().state).toBe('active');
    expect(session.getSnapshot().roomName).toBe('general');
  });

  it('uses the texts it is given as they are', async () => {
    const { calls, session } = setup();
    await session.startVoiceSession({
      ...START,
      muted: true,
      texts: { title: 'Na voz em #{x}', text: 'Casa' },
    });
    expect(calls).toContain('startService Na voz em #{x} | Casa | muted=true mic=true');
  });

  it('rejects without the microphone permission and touches nothing', async () => {
    const { calls, session } = setup({ mic: false });
    await expect(session.startVoiceSession(START)).rejects.toMatchObject({
      code: 'mic_permission',
    });
    expect(calls).not.toContain('audio communication');
    expect(calls).not.toContain('startService');
    expect(session.getSnapshot().state).toBe('idle');
  });

  it('a listen-only call does not need the microphone', async () => {
    const { calls, session } = setup({ mic: false });
    await session.startVoiceSession({ ...START, microphone: false });
    expect(calls.some((c) => c.endsWith('mic=false'))).toBe(true);
  });

  it('undoes everything when the service cannot start', async () => {
    const { calls, session, audio } = setup({ startFails: true });
    await expect(session.startVoiceSession(START)).rejects.toMatchObject({
      code: 'service_failed',
    });
    expect(calls.slice(-4)).toEqual([
      'stopService',
      'clearRoute',
      'useMediaDevice',
      'audio release',
    ]);
    expect(session.getSnapshot().state).toBe('idle');
    expect(audio.mode).toBeNull();
  });

  it('refuses a second session while one is on', async () => {
    const { session } = setup();
    await session.startVoiceSession(START);
    await expect(session.startVoiceSession(START)).rejects.toBeInstanceOf(VoiceSessionError);
    expect(session.getSnapshot().state).toBe('active');
  });

  it('a stop while starting cancels the start and stops the service again', async () => {
    const { calls, session, hold, release } = setup();
    hold();
    const started = session.startVoiceSession(START);
    const settled = expect(started).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(calls.some((c) => c.startsWith('startService'))).toBe(true));
    session.stopVoiceSession();
    release();
    await settled;
    expect(calls.filter((c) => c === 'stopService').length).toBeGreaterThanOrEqual(2);
    expect(session.getSnapshot().state).toBe('idle');
  });

  it('is unsupported without a native side', async () => {
    const session = new VoiceSessionController(
      null,
      setup().session['permissions'],
      new AudioModeController(null),
    );
    expect(session.supported).toBe(false);
    await expect(session.startVoiceSession(START)).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('stopVoiceSession', () => {
  it('stops the service, the route and the voice device, and gives the audio back', async () => {
    const { calls, session, audio } = setup();
    await session.startVoiceSession(START);
    calls.length = 0;
    session.stopVoiceSession();
    session.stopVoiceSession();
    expect(calls).toEqual(['stopService', 'clearRoute', 'useMediaDevice', 'audio release']);
    expect(audio.mode).toBeNull();
  });

  it('goes back to media when a stream is still watched', async () => {
    const { calls, session, audio } = setup();
    audio.setAudioMode('media');
    await session.startVoiceSession(START);
    expect(audio.mode).toBe('communication');
    // The player's own requests during voice do not take the mode away.
    audio.setAudioMode('media');
    expect(audio.mode).toBe('communication');
    calls.length = 0;
    session.stopVoiceSession();
    expect(audio.mode).toBe('media');
    expect(calls).toContain('audio media');
  });

  it('releases when the player closed during the call', async () => {
    const { session, audio } = setup();
    audio.setAudioMode('media');
    await session.startVoiceSession(START);
    audio.releaseMedia();
    session.stopVoiceSession();
    expect(audio.mode).toBeNull();
  });

  it('keeps going when one step throws', async () => {
    const { calls, native, session } = setup();
    await session.startVoiceSession(START);
    native.stopService = () => {
      throw new Error('gone');
    };
    calls.length = 0;
    session.stopVoiceSession();
    expect(calls).toEqual(['clearRoute', 'useMediaDevice', 'audio release']);
  });
});

describe('the notification', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('mute and unmute update the state and the notification, and reach the listener', async () => {
    const { calls, session, emit } = setup();
    await session.startVoiceSession(START);
    const seen: string[] = [];
    session.onNotificationAction((a) => seen.push(a));
    emit({ type: 'action', action: 'mute' });
    expect(session.getSnapshot().muted).toBe(true);
    expect(calls).toContain('updateService muted=true');
    emit({ type: 'action', action: 'unmute' });
    expect(session.getSnapshot().muted).toBe(false);
    expect(seen).toEqual(['mute', 'unmute']);
  });

  it('setMuted from the app updates the notification once', async () => {
    const { calls, session } = setup();
    await session.startVoiceSession(START);
    session.setMuted(true);
    session.setMuted(true);
    expect(calls.filter((c) => c.startsWith('updateService'))).toEqual([
      'updateService muted=true',
    ]);
  });

  it('leave goes to the listener, which ends the session', async () => {
    const { session, emit } = setup();
    await session.startVoiceSession(START);
    const ended: string[] = [];
    session.onSessionEnded((r) => ended.push(r));
    session.onNotificationAction((a) => {
      if (a === 'leave') session.stopVoiceSession();
    });
    emit({ type: 'action', action: 'leave' });
    expect(session.getSnapshot().state).toBe('idle');
    expect(ended).toEqual(['stopped']);
  });

  it('leave with nobody listening stops the session at once', async () => {
    const { session, emit } = setup();
    await session.startVoiceSession(START);
    const ended: string[] = [];
    session.onSessionEnded((r) => ended.push(r));
    emit({ type: 'action', action: 'leave' });
    expect(session.getSnapshot().state).toBe('idle');
    expect(ended).toEqual(['leave_action']);
  });

  it('leave that a listener ignores is forced after a grace', async () => {
    const { session, emit } = setup();
    await session.startVoiceSession(START);
    session.onNotificationAction(() => undefined);
    emit({ type: 'action', action: 'leave' });
    expect(session.getSnapshot().state).toBe('active');
    vi.advanceTimersByTime(LEAVE_GRACE_MS);
    expect(session.getSnapshot().state).toBe('idle');
  });

  it('a swiped-away app ends the session with its reason', async () => {
    const { calls, session, emit } = setup();
    await session.startVoiceSession(START);
    const ended: string[] = [];
    session.onSessionEnded((r) => ended.push(r));
    calls.length = 0;
    emit({ type: 'ended', reason: 'task_removed' });
    expect(ended).toEqual(['task_removed']);
    expect(calls).toContain('useMediaDevice');
    expect(session.getSnapshot().state).toBe('idle');
  });

  it('ignores actions and endings when there is no session', () => {
    const { session, emit } = setup();
    emit({ type: 'action', action: 'leave' });
    expect(session.getSnapshot().state).toBe('idle');
  });
});

describe('the route', () => {
  it('starts with the preference and follows what the phone reports', async () => {
    const { calls, session, emit } = setup();
    await session.startVoiceSession({ ...START, route: 'earpiece' });
    expect(calls).toContain('setRoute earpiece');
    emit({ type: 'route', route: { active: 'bluetooth', available: ['speaker', 'bluetooth'] } });
    expect(session.getSnapshot().active).toBe('bluetooth');
    expect(session.getSnapshot().available).toEqual(['speaker', 'bluetooth']);
  });

  it('changing it while on goes to the phone; before a session it is only remembered', async () => {
    const { calls, session, setRoute } = setup();
    session.setRoute('speaker');
    expect(calls).not.toContain('setRoute speaker');
    await session.startVoiceSession({ ...START, route: session.getSnapshot().route });
    setRoute({ active: 'speaker', available: ['speaker'] });
    session.setRoute('auto');
    expect(calls.filter((c) => c.startsWith('setRoute'))).toEqual([
      'setRoute speaker',
      'setRoute auto',
    ]);
  });
});

describe('permissions', () => {
  it('already granted: no question', async () => {
    const { calls, session } = setup();
    expect(await session.requestMicPermission()).toBe('granted');
    expect(calls).toEqual([]);
  });

  it('explains first, then asks', async () => {
    const { calls, session } = setup({ mic: false });
    expect(await session.requestMicPermission()).toBe('granted');
    expect(calls).toEqual(['explainMic', 'requestMic']);
  });

  it('does not ask when the person declines the explanation', async () => {
    const { calls, session } = setup({ mic: false });
    expect(await session.requestMicPermission(async () => false)).toBe('denied');
    expect(calls).toEqual([]);
  });

  it('passes on a blocked answer', async () => {
    const { session } = setup({ mic: false, micResult: 'blocked' });
    expect(await session.requestMicPermission()).toBe('blocked');
  });
});

describe('the mic meter', () => {
  it('starts and stops the monitor and passes levels on', () => {
    const { calls, session, emit } = setup();
    const levels: number[] = [];
    const stop = session.startMicMeter((l) => levels.push(l));
    emit({ type: 'level', level: 0.4 });
    stop();
    expect(levels).toEqual([0.4]);
    expect(calls).toEqual(['startMicMonitor', 'stopMicMonitor']);
  });
});
