// SPDX-License-Identifier: AGPL-3.0-only
import {
  type DevicesLike as CoreDevicesLike,
  type SpeakingMonitor as CoreSpeakingMonitor,
  type VoiceClientOptions as CoreVoiceClientOptions,
  VoiceClient as CoreVoiceClient,
  type VoiceMedia as CoreVoiceMedia,
  type VoiceOutput as CoreVoiceOutput,
} from '@openlive/client';

// The voice client is @openlive/client's VoiceClient (voice/
// client.ts there has the story: join, mute, deafen, push-to-talk, the publication and the pulls);
// this binds it to the browser's MediaStreamTrack and keyboard.

export {
  type DeviceOption,
  errorNameOf,
  micConstraints,
  micErrorOf,
  type MicError,
  type SignalVoice,
  type VoiceClientState,
  type VoicePhase,
  type VoiceSignal,
} from '@openlive/client';

export type VoiceMedia = CoreVoiceMedia<MediaStreamTrack>;
/** navigator.mediaDevices, or a fake. */
export type DevicesLike = CoreDevicesLike<MediaStreamTrack>;
export type VoiceOutput = CoreVoiceOutput<MediaStreamTrack>;
export type SpeakingMonitor = CoreSpeakingMonitor<MediaStreamTrack>;
export type VoiceClientOptions = CoreVoiceClientOptions<MediaStreamTrack>;

/** Typing in a field never triggers push-to-talk. */
export function isEditable(target: unknown): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export class VoiceClient extends CoreVoiceClient<MediaStreamTrack> {
  constructor(options: VoiceClientOptions) {
    super({ isEditable, ...options });
  }
}
