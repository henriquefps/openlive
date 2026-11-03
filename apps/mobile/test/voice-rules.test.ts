// SPDX-License-Identifier: AGPL-3.0-only
import { personMenuAbilities, stageLayout } from '@openlive/client';
import { describe, expect, it } from 'vitest';
import { sliderValue } from '../src/voice/slider.ts';
import {
  type BackgroundInput,
  backgroundRules,
  pttPressed,
  reconnectOnNetwork,
} from '../src/voice/rules.ts';
import type { PhoneVoiceState } from '../src/voice/phone-voice.ts';
import { micProblem, stateIcons, voiceControls } from '../src/voice/view.ts';

const base = {
  phase: 'joined',
  muted: false,
  deafened: false,
  serverMuted: false,
  pushToTalk: false,
  pttPressed: false,
  transmitting: true,
  micError: null,
  error: null,
  preparing: false,
  joinFailure: null,
  micBlocked: false,
} as unknown as PhoneVoiceState;
const state = (patch: Partial<PhoneVoiceState>): PhoneVoiceState => ({ ...base, ...patch });

describe('voice controls state', () => {
  it('reads sending, muted, deafened and push to talk', () => {
    expect(voiceControls(base).status).toBe('sending');
    expect(voiceControls(state({ muted: true })).status).toBe('muted');
    expect(voiceControls(state({ muted: true, deafened: true })).status).toBe('deafened');
    expect(voiceControls(state({ pushToTalk: true })).status).toBe('pushToTalk');
  });

  it('shows "A moderator muted you" and takes mute away from the person', () => {
    const c = voiceControls(state({ serverMuted: true }));
    expect(c.status).toBe('serverMuted');
    expect(c.canMute).toBe(false);
    expect(c.showTalkButton).toBe(false);
  });

  it('connecting until joined; listening when the microphone is missing', () => {
    expect(voiceControls(state({ phase: 'joining' })).status).toBe('connecting');
    const listening = voiceControls(state({ micError: 'denied' }));
    expect(listening.status).toBe('listening');
    expect(listening.canMute).toBe(false);
  });

  it('the talk button is the push-to-talk mode only, while joined with a microphone', () => {
    expect(voiceControls(state({ pushToTalk: true })).showTalkButton).toBe(true);
    expect(voiceControls(base).showTalkButton).toBe(false);
    expect(voiceControls(state({ pushToTalk: true, phase: 'joining' })).showTalkButton).toBe(false);
    expect(voiceControls(state({ pushToTalk: true, micError: 'failed' })).showTalkButton).toBe(
      false,
    );
  });

  it('says it is talking only while the button is held and the microphone is open', () => {
    expect(voiceControls(state({ pushToTalk: true, pttPressed: true })).talking).toBe(true);
    expect(
      voiceControls(state({ pushToTalk: true, pttPressed: true, transmitting: false })).talking,
    ).toBe(false);
  });

  it('names why there is no microphone', () => {
    expect(micProblem(base)).toBeNull();
    expect(micProblem(state({ micBlocked: true }))).toBe('mobile.voice.micBlocked');
    expect(micProblem(state({ micError: 'no_device' }))).toBe('mobile.voice.micError.no_device');
  });

  it("shows a person's icons: server mute beats mute, deafened hides plain mute", () => {
    const p = { userId: 'a', muted: false, deafened: false, serverMuted: false, camera: false };
    expect(stateIcons(p as never)).toEqual([]);
    expect(stateIcons({ ...p, muted: true, serverMuted: true } as never)).toEqual(['serverMuted']);
    expect(stateIcons({ ...p, muted: true, deafened: true, camera: true } as never)).toEqual([
      'deafened',
      'camera',
    ]);
  });
});

describe('push to talk', () => {
  it('opens on a press and closes on release or a cancelled touch', () => {
    expect(pttPressed('down')).toBe(true);
    expect(pttPressed('up')).toBe(false);
    expect(pttPressed('cancel')).toBe(false);
  });
});

describe("moderation menu per role (the web's PersonMenu rule)", () => {
  const target = (role: 'owner' | 'admin' | 'member' | 'guest', camera = false) => ({
    userId: 'target',
    role,
    camera,
  });
  const viewer = (role: 'owner' | 'admin' | 'member' | 'guest' | null, canModerate = true) => ({
    userId: 'me',
    role,
    canModerate,
  });

  it('an owner moderates everyone else', () => {
    for (const role of ['admin', 'member', 'guest'] as const) {
      expect(personMenuAbilities(viewer('owner'), target(role))).toMatchObject({
        serverMute: true,
        kick: true,
      });
    }
  });

  it('an admin moderates members and guests, not owners or other admins', () => {
    expect(personMenuAbilities(viewer('admin'), target('member')).kick).toBe(true);
    expect(personMenuAbilities(viewer('admin'), target('guest')).serverMute).toBe(true);
    expect(personMenuAbilities(viewer('admin'), target('admin')).kick).toBe(false);
    expect(personMenuAbilities(viewer('admin'), target('owner')).serverMute).toBe(false);
  });

  it('members and guests get nothing, whatever the server says', () => {
    for (const role of ['member', 'guest'] as const) {
      expect(personMenuAbilities(viewer(role, false), target('guest'))).toEqual({
        serverMute: false,
        kick: false,
        cameraOff: false,
      });
    }
    // canModerate comes from the room; the role alone does not grant it.
    expect(personMenuAbilities(viewer('owner', false), target('member')).kick).toBe(false);
  });

  it('nothing for yourself', () => {
    expect(
      personMenuAbilities(viewer('owner'), { userId: 'me', role: 'owner', camera: true }),
    ).toEqual({ serverMute: false, kick: false, cameraOff: false });
  });

  it('turning a camera off is offered only while the camera is on', () => {
    expect(personMenuAbilities(viewer('owner'), target('member', false)).cameraOff).toBe(false);
    expect(personMenuAbilities(viewer('owner'), target('member', true)).cameraOff).toBe(true);
  });
});

describe('background rules', () => {
  const input: BackgroundInput = {
    appState: 'background',
    inVoice: true,
    reconnecting: false,
    watching: false,
  };

  it('never lets go of the voice in the background', () => {
    for (const appState of ['background', 'inactive', 'active'] as const) {
      expect(backgroundRules({ ...input, appState }).releaseVoice).toBe(false);
    }
  });

  it('gives back the watch slot only, while in voice or not', () => {
    expect(backgroundRules({ ...input, watching: true }).releaseWatch).toBe(true);
    expect(backgroundRules({ ...input, watching: true, inVoice: false }).releaseWatch).toBe(true);
    expect(backgroundRules({ ...input, watching: true, appState: 'active' }).releaseWatch).toBe(
      false,
    );
    expect(backgroundRules(input).releaseWatch).toBe(false);
  });

  it('closes the camera in the background, not the voice', () => {
    expect(backgroundRules(input)).toMatchObject({ stopCamera: true, releaseVoice: false });
    expect(backgroundRules({ ...input, appState: 'active' }).stopCamera).toBe(false);
  });

  it('coming back to the front retries a socket that was waiting', () => {
    expect(backgroundRules({ ...input, appState: 'active', reconnecting: true }).reconnectNow).toBe(
      true,
    );
    expect(backgroundRules({ ...input, appState: 'active' }).reconnectNow).toBe(false);
    expect(backgroundRules({ ...input, reconnecting: true }).reconnectNow).toBe(false);
  });
});

describe('network changes', () => {
  const wifi = { isConnected: true, type: 'wifi' };
  const cell = { isConnected: true, type: 'cellular' };
  const none = { isConnected: false, type: 'none' };

  it('Wi-Fi to cellular while in voice reconnects at once', () => {
    expect(reconnectOnNetwork(wifi, cell, true)).toBe(true);
    expect(reconnectOnNetwork(cell, wifi, true)).toBe(true);
  });

  it('the network coming back reconnects, in voice or not', () => {
    expect(reconnectOnNetwork(none, wifi, true)).toBe(true);
    expect(reconnectOnNetwork(none, cell, false)).toBe(true);
  });

  it('a change out of voice, no change, losing the network or the first reading do nothing', () => {
    expect(reconnectOnNetwork(wifi, cell, false)).toBe(false);
    expect(reconnectOnNetwork(wifi, wifi, true)).toBe(false);
    expect(reconnectOnNetwork(wifi, none, true)).toBe(false);
    expect(reconnectOnNetwork(null, wifi, true)).toBe(false);
  });
});

describe('the call layout on a phone', () => {
  const stage = { width: 360, height: 420 };

  it('fills the stage with cameras in a gallery and puts voice-only people in the strip', () => {
    const layout = stageLayout({
      tiles: [
        { id: 'me', video: true, self: true },
        { id: 'ana', video: true },
        { id: 'bo', video: true },
        { id: 'cy', video: false },
      ],
      ...stage,
    });
    expect(layout.mode).toBe('gallery');
    expect(layout.main).toEqual(['me', 'ana', 'bo']);
    expect(layout.strip).toEqual(['cy']);
    expect(layout.pip).toBeNull();
  });

  it('a 1:1 call puts you in a corner over the other person', () => {
    const layout = stageLayout({
      tiles: [
        { id: 'me', video: true, self: true },
        { id: 'ana', video: true },
      ],
      ...stage,
    });
    expect(layout.main).toEqual(['ana']);
    expect(layout.pip).toBe('me');
  });

  it('a pinned camera takes the stage and the others go to a strip under it', () => {
    const layout = stageLayout({
      tiles: [
        { id: 'me', video: true, self: true },
        { id: 'ana', video: true },
        { id: 'bo', video: true },
      ],
      ...stage,
      pinned: 'ana',
    });
    expect(layout).toMatchObject({ mode: 'spotlight', main: ['ana'], stripSide: 'bottom' });
    expect(layout.strip).toEqual(['me', 'bo']);
  });
});

describe('volume slider', () => {
  it('maps a touch to a 5 % step from 0 to 200 %', () => {
    expect(sliderValue(0, 200, 200, 5)).toBe(0);
    expect(sliderValue(100, 200, 200, 5)).toBe(100);
    expect(sliderValue(200, 200, 200, 5)).toBe(200);
    expect(sliderValue(-40, 200, 200, 5)).toBe(0);
    expect(sliderValue(260, 200, 200, 5)).toBe(200);
    expect(sliderValue(51, 200, 200, 5)).toBe(50);
    expect(sliderValue(10, 0, 200, 5)).toBe(0);
  });
});
