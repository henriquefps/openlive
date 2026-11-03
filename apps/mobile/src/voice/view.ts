// SPDX-License-Identifier: AGPL-3.0-only
import type { VoiceParticipant } from '@openlive/client';
import type { PhoneVoiceState } from './phone-voice.ts';

// What the voice controls show for a voice state, as pure functions of it (the web's VoiceBar
// rules, for a phone): which status line, whether mute and the talk button work, and how a
// participant's icons read.

export type VoiceStatus =
  'connecting' | 'listening' | 'deafened' | 'serverMuted' | 'muted' | 'pushToTalk' | 'sending';

export interface VoiceControls {
  /** In voice (joined) with the microphone usable. */
  canMute: boolean;
  status: VoiceStatus;
  /** The big hold-to-talk button replaces the mute toggle. */
  showTalkButton: boolean;
  /** The hold-to-talk button is being held (the microphone is open). */
  talking: boolean;
  /** Mute and deafen are available: only while joined. */
  joined: boolean;
}

export function voiceControls(state: PhoneVoiceState): VoiceControls {
  const joined = state.phase === 'joined';
  const canMute = state.micError === null && !state.serverMuted && state.error === null;
  let status: VoiceStatus;
  if (!joined) status = 'connecting';
  else if (state.micError !== null || state.error !== null) status = 'listening';
  else if (state.deafened) status = 'deafened';
  else if (state.serverMuted) status = 'serverMuted';
  else if (state.muted) status = 'muted';
  else if (state.pushToTalk) status = 'pushToTalk';
  else status = 'sending';
  return {
    canMute,
    status,
    // Push-to-talk is a mode: muted or deafened, the button still shows but cannot open the mic.
    showTalkButton: joined && state.pushToTalk && canMute,
    talking: state.pttPressed && state.transmitting,
    joined,
  };
}

/** The icons next to a person's name: server mute wins over mute; deafened hides plain mute. */
export function stateIcons(
  p: VoiceParticipant,
): ('serverMuted' | 'muted' | 'deafened' | 'camera')[] {
  const icons: ('serverMuted' | 'muted' | 'deafened' | 'camera')[] = [];
  if (p.serverMuted) icons.push('serverMuted');
  else if (p.muted && !p.deafened) icons.push('muted');
  if (p.deafened) icons.push('deafened');
  if (p.camera) icons.push('camera');
  return icons;
}

/** The text key (mobile.voice.* or voice.*) for why the microphone is not there. */
export function micProblem(state: PhoneVoiceState): string | null {
  if (state.micBlocked) return 'mobile.voice.micBlocked';
  if (state.micError !== null) return `mobile.voice.micError.${state.micError}`;
  return null;
}
