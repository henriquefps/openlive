// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.ts';
import { micConstraints } from '../src/voice/client.ts';
import { rms, SPEAKING_HOLD_MS, SpeakingGate } from '../src/voice/levels.ts';
import { keyLabel, loadPersonVolume, loadPrefs, savePersonVolume } from '../src/voice/prefs.ts';
import { asTrack, audioTrack, FakeMicTrack, participant, setupVoice } from './voice-fakes.ts';

// The voice client's state machine against fakes (voice-fakes.ts): join → publish → pull →
// leave, mute, deafen and push-to-talk, device loss, refused permissions and the room's answers.

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Joined, with Bia in voice and her track listed. */
async function joined(options: Parameters<typeof setupVoice>[0] = {}) {
  const v = setupVoice(options);
  void v.client.join();
  await settle();
  v.signal.admit([participant('u_bia')]);
  v.signal.update({ tracks: [audioTrack('u_me'), audioTrack('u_bia')] });
  await settle();
  return v;
}

describe('VoiceClient: join and leave', () => {
  it('asks for the microphone with echo cancellation, noise suppression and gain control', async () => {
    const v = setupVoice({ prefs: { inputId: 'mic-a' } });
    void v.client.join();
    expect(v.client.getState().phase).toBe('joining');
    await settle();
    expect(v.devices.devices.getUserMedia).toHaveBeenCalledWith(micConstraints('mic-a'));
    expect(micConstraints('')).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    expect(v.signal.sent).toEqual([
      { type: 'voice.join', payload: { muted: false, deafened: false } },
    ]);
    expect(v.output.resume).toHaveBeenCalled();
  });

  it('publishes the microphone once the room lets it in, then pulls the others', async () => {
    const v = await joined();
    const state = v.client.getState();
    expect(state.phase).toBe('joined');
    expect(v.media.media.publish).toHaveBeenCalledWith(asTrack(v.mic()));
    expect(state.transmitting).toBe(true);
    expect(v.mic().enabled).toBe(true);
    // Its own track is never pulled.
    expect(v.media.media.pull).toHaveBeenCalledTimes(1);
    expect(v.media.media.pull.mock.calls[0]?.[0]).toEqual([audioTrack('u_bia')]);
    expect(v.playing.has('u_bia')).toBe(true);
    expect(v.monitored).toEqual(new Set(['self', 'u_bia']));
    expect(v.signal.states()).toEqual([{ muted: false, deafened: false }]);
  });

  it('closes who left before pulling who came', async () => {
    const v = await joined();
    v.signal.update({ tracks: [audioTrack('u_cai')] });
    await settle();
    expect(v.media.media.unpull).toHaveBeenCalledWith(['tr_u_bia'], expect.anything());
    expect(v.media.media.unpull.mock.invocationCallOrder[0]).toBeLessThan(
      v.media.media.pull.mock.invocationCallOrder[1] ?? 0,
    );
    expect([...v.playing.keys()]).toEqual(['u_cai']);
  });

  it('leave() unpublishes, closes the pulls, stops the microphone and tells the room', async () => {
    const v = await joined();
    v.client.leave();
    expect(v.client.getState().phase).toBe('idle');
    expect(v.media.media.unpublish).toHaveBeenCalledTimes(1);
    expect(v.media.media.unpull).toHaveBeenCalledWith(['tr_u_bia'], expect.anything());
    expect(v.mic().readyState).toBe('ended');
    expect(v.playing.size).toBe(0);
    expect(v.monitored.size).toBe(0);
    expect(v.signal.sent.at(-1)).toEqual({ type: 'voice.leave' });
  });

  it('a refused join (voice full) ends listening with the error', async () => {
    const v = setupVoice();
    void v.client.join();
    await settle();
    v.signal.update({ self: 'out', error: { code: 'voice_full', limit: 12 } });
    const state = v.client.getState();
    expect(state.phase).toBe('idle');
    expect(state.error).toEqual({ code: 'voice_full', limit: 12 });
    expect(v.mic().readyState).toBe('ended');
    expect(v.media.media.publish).not.toHaveBeenCalled();
  });

  it('removed by an owner: back to idle and says so', async () => {
    const v = await joined();
    v.signal.update({ self: 'out', tracks: [], left: 'kicked' });
    expect(v.client.getState()).toMatchObject({ phase: 'idle', removed: 'kicked' });
    expect(v.mic().readyState).toBe('ended');
  });

  it('the socket dropped: publishes again when the room lets it back in', async () => {
    const v = await joined();
    v.signal.update({ self: 'joining', participants: [], tracks: [], left: 'disconnected' });
    expect(v.client.getState().phase).toBe('joining');
    expect(v.media.media.unpublish).toHaveBeenCalledTimes(1);
    expect(v.playing.size).toBe(0);
    v.signal.admit([participant('u_bia')]);
    v.signal.update({ tracks: [audioTrack('u_bia')] });
    await settle();
    expect(v.client.getState().phase).toBe('joined');
    expect(v.media.media.publish).toHaveBeenCalledTimes(2);
    expect(v.playing.has('u_bia')).toBe(true);
  });

  it('a new SFU session: publishes and pulls everything again', async () => {
    const v = await joined();
    v.media.reset();
    await settle();
    expect(v.media.media.publish).toHaveBeenCalledTimes(2);
    expect(v.media.media.pull).toHaveBeenCalledTimes(2);
    expect(v.client.getState().transmitting).toBe(true);
  });

  it('a join that resolves after leave() does nothing', async () => {
    const v = setupVoice();
    void v.client.join();
    v.client.leave();
    await settle();
    expect(v.client.getState().phase).toBe('idle');
    expect(v.signal.sent).toEqual([{ type: 'voice.leave' }]);
    expect(v.mic().readyState).toBe('ended');
  });
});

describe('VoiceClient: mute, deafen, push-to-talk', () => {
  it('mute switches the track off without renegotiating and tells the room', async () => {
    const v = await joined();
    v.client.setMuted(true);
    expect(v.mic().enabled).toBe(false);
    expect(v.client.getState().transmitting).toBe(false);
    expect(v.media.media.publish).toHaveBeenCalledTimes(1);
    expect(v.signal.states().at(-1)).toEqual({ muted: true, deafened: false });
    v.client.setMuted(false);
    expect(v.mic().enabled).toBe(true);
  });

  it('deafen silences the voices and mutes; lifting it gives the previous mute back', async () => {
    const v = await joined();
    v.client.setDeafened(true);
    expect(v.output.deafened).toBe(true);
    expect(v.client.getState()).toMatchObject({ muted: true, deafened: true });
    expect(v.mic().enabled).toBe(false);
    v.client.setDeafened(false);
    expect(v.output.deafened).toBe(false);
    expect(v.client.getState()).toMatchObject({ muted: false, deafened: false });

    v.client.setMuted(true);
    v.client.setDeafened(true);
    v.client.setDeafened(false);
    expect(v.client.getState().muted).toBe(true);
  });

  it('unmuting while deafened lifts deafen too', async () => {
    const v = await joined();
    v.client.setDeafened(true);
    v.client.setMuted(false);
    expect(v.client.getState()).toMatchObject({ muted: false, deafened: false });
    expect(v.signal.states().at(-1)).toEqual({ muted: false, deafened: false });
  });

  it('server mute drops the publication (the room closed it); lifted, publishes again', async () => {
    const v = await joined();
    v.signal.update({ participants: [participant('u_me', { serverMuted: true })] });
    expect(v.client.getState()).toMatchObject({ serverMuted: true, transmitting: false });
    expect(v.mic().enabled).toBe(false);
    expect(v.media.media.unpublish).toHaveBeenCalledTimes(1);
    v.client.setMuted(false);
    expect(v.mic().enabled).toBe(false);
    v.signal.update({ participants: [participant('u_me')] });
    await settle();
    expect(v.media.media.publish).toHaveBeenCalledTimes(2);
    expect(v.mic().enabled).toBe(true);
  });

  it('without canSpeak: joins to listen, never asks for the microphone', async () => {
    const v = setupVoice();
    v.signal.update({ canSpeak: false });
    void v.client.join();
    await settle();
    v.signal.admit();
    await settle();
    expect(v.devices.devices.getUserMedia).not.toHaveBeenCalled();
    expect(v.media.media.publish).not.toHaveBeenCalled();
    expect(v.client.getState()).toMatchObject({ phase: 'joined', transmitting: false });
  });

  it('moved to another tab: back to idle and says so', async () => {
    const v = await joined();
    v.signal.update({ self: 'out', tracks: [], left: 'moved' });
    expect(v.client.getState()).toMatchObject({ phase: 'idle', removed: 'moved' });
  });

  it('push-to-talk sends only while the key is held, outside text fields', async () => {
    const keys = new EventTarget();
    const v = await joined({ keys, prefs: { pushToTalk: true, pushToTalkKey: 'KeyT' } });
    expect(v.mic().enabled).toBe(false);
    keys.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT' }));
    expect(v.mic().enabled).toBe(true);
    keys.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyT' }));
    expect(v.mic().enabled).toBe(false);
    // Another key does nothing.
    keys.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }));
    expect(v.mic().enabled).toBe(false);
    // Typing in a field does nothing.
    const input = document.createElement('input');
    document.body.append(input);
    input.addEventListener('keydown', (e) => keys.dispatchEvent(new KeyboardEvent(e.type, e)));
    const typed = new KeyboardEvent('keydown', { code: 'KeyT' });
    Object.defineProperty(typed, 'target', { value: input });
    keys.dispatchEvent(typed);
    expect(v.mic().enabled).toBe(false);
    input.remove();
    // Leaving the tab with the key down releases it.
    keys.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT' }));
    keys.dispatchEvent(new Event('blur'));
    expect(v.mic().enabled).toBe(false);
  });

  it('push-to-talk is remembered with its key', async () => {
    const v = setupVoice();
    v.client.setPushToTalk(true, 'KeyB');
    expect(v.saved.at(-1)).toMatchObject({ pushToTalk: true, pushToTalkKey: 'KeyB' });
    expect(v.client.getState()).toMatchObject({ pushToTalk: true, pushToTalkKey: 'KeyB' });
  });
});

describe('VoiceClient: devices and permissions', () => {
  it('microphone denied: in voice listening only, with the reason', async () => {
    const v = setupVoice();
    v.devices.fail('NotAllowedError');
    void v.client.join();
    await settle();
    v.signal.admit([participant('u_bia')]);
    v.signal.update({ tracks: [audioTrack('u_bia')] });
    await settle();
    expect(v.client.getState()).toMatchObject({
      phase: 'joined',
      micError: 'denied',
      transmitting: false,
    });
    expect(v.media.media.publish).not.toHaveBeenCalled();
    expect(v.playing.has('u_bia')).toBe(true);
  });

  it('no microphone at all: listening only', async () => {
    const v = setupVoice();
    v.devices.fail('NotFoundError');
    void v.client.join();
    await settle();
    expect(v.client.getState().micError).toBe('no_device');
  });

  it('no media devices API (insecure page): listening only', async () => {
    const v = setupVoice({ noDevices: true });
    void v.client.join();
    await settle();
    expect(v.client.getState().micError).toBe('unsupported');
  });

  it('the remembered microphone is gone: falls back to the default one', async () => {
    const v = setupVoice({ prefs: { inputId: 'gone' } });
    v.devices.devices.getUserMedia.mockImplementationOnce(() =>
      Promise.reject(new DOMException('gone', 'OverconstrainedError')),
    );
    void v.client.join();
    await settle();
    expect(v.devices.devices.getUserMedia).toHaveBeenLastCalledWith(micConstraints(''));
    expect(v.client.getState().micError).toBeNull();
  });

  it('a microphone unplugged mid-call: switches to another one on the same track', async () => {
    const v = await joined({ prefs: { inputId: 'mic-a' } });
    const first = v.mic();
    first.unplug();
    await settle();
    const second = v.mic();
    expect(second).not.toBe(first);
    expect(v.media.publications[0]?.replaced).toEqual([null, asTrack(second)]);
    expect(v.client.getState()).toMatchObject({ micError: null, transmitting: true });
    expect(v.media.media.publish).toHaveBeenCalledTimes(1);
  });

  it('the last microphone unplugged: listening only, and back when one is plugged in', async () => {
    const v = await joined();
    v.devices.fail('NotFoundError');
    v.mic().unplug();
    await settle();
    expect(v.client.getState()).toMatchObject({ micError: 'no_device', transmitting: false });
    v.devices.fail(null);
    v.devices.change();
    await settle();
    expect(v.client.getState()).toMatchObject({ micError: null, transmitting: true });
  });

  it('picking another microphone swaps the published track', async () => {
    const v = await joined();
    const first = v.mic();
    await v.client.setInput('mic-b');
    expect(first.readyState).toBe('ended');
    expect(v.devices.devices.getUserMedia).toHaveBeenLastCalledWith(micConstraints('mic-b'));
    expect(v.media.publications[0]?.replaced).toEqual([asTrack(v.mic())]);
    expect(v.saved.at(-1)?.inputId).toBe('mic-b');
  });

  it('lists the devices without the "default" alias and names unlabelled ones', async () => {
    const v = setupVoice();
    await v.client.refreshDevices();
    expect(v.client.getState().inputs).toEqual([
      { deviceId: 'mic-a', label: 'Headset' },
      { deviceId: 'mic-b', label: 'Microphone 2' },
    ]);
    expect(v.client.getState().outputs).toEqual([{ deviceId: 'spk-a', label: 'Speakers' }]);
  });

  it('picking the speakers goes to the output and is remembered', async () => {
    const v = setupVoice();
    await v.client.setOutput('spk-a');
    expect(v.output.sink).toBe('spk-a');
    expect(v.saved.at(-1)?.outputId).toBe('spk-a');
  });

  it('not allowed to speak: stays in voice listening only', async () => {
    const v = setupVoice();
    v.media.media.publish.mockRejectedValueOnce(
      new ApiError(403, { code: 'voice_speak_not_allowed' }),
    );
    void v.client.join();
    await settle();
    v.signal.admit();
    await settle();
    expect(v.client.getState()).toMatchObject({
      phase: 'joined',
      error: { code: 'voice_speak_not_allowed' },
      transmitting: false,
    });
    expect(v.mic().readyState).toBe('ended');
  });
});

describe('VoiceClient: volume and speaking', () => {
  it('per-person volume goes to the output and is remembered', async () => {
    const v = await joined();
    v.client.setVolume('u_bia', 1.5);
    expect(v.playing.get('u_bia')?.volume).toBe(1.5);
    expect(v.volumes.get('u_bia')).toBe(1.5);
    v.client.setVolume('u_bia', 9);
    expect(v.client.getState().volumes['u_bia']).toBe(2);
  });

  it('a remembered volume applies when the person is pulled', async () => {
    const v = setupVoice();
    v.volumes.set('u_bia', 0.4);
    void v.client.join();
    await settle();
    v.signal.admit([participant('u_bia')]);
    v.signal.update({ tracks: [audioTrack('u_bia')] });
    await settle();
    expect(v.output.attach).toHaveBeenCalledWith('u_bia', expect.anything(), 0.4);
  });

  it('speaking: others as measured, self only while transmitting', async () => {
    const v = await joined();
    v.speak('u_bia', true);
    v.speak('self', true);
    expect(v.client.getState().speaking).toEqual({ u_bia: true, u_me: true });
    v.client.setMuted(true);
    expect(v.client.getState().speaking['u_me']).toBe(false);
    v.speak('self', true);
    expect(v.client.getState().speaking['u_me']).toBe(false);
  });
});

describe('speaking gate and prefs', () => {
  it('speaks above the level and stops after the hold', () => {
    const gate = new SpeakingGate();
    expect(gate.update(0.2, 0)).toBe(true);
    expect(gate.update(0, 100)).toBe(true);
    expect(gate.update(0, SPEAKING_HOLD_MS)).toBe(false);
    expect(gate.update(0.001, SPEAKING_HOLD_MS + 100)).toBe(false);
  });

  it('rms of a block', () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array())).toBe(0);
  });

  it('prefs survive bad storage and clamp volumes', () => {
    const store = new Map<string, string>([['openlive.voice', '{bad']]);
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(loadPrefs(storage).pushToTalkKey).toBe('KeyV');
    savePersonVolume('u_bia', 5, storage);
    expect(loadPersonVolume('u_bia', storage)).toBe(2);
    expect(loadPersonVolume('u_cai', storage)).toBe(1);
    expect(keyLabel('KeyT')).toBe('T');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('Space')).toBe('Space');
  });

  it('FakeMicTrack is a track', () => {
    expect(asTrack(new FakeMicTrack('x')).kind).toBe('audio');
  });
});
