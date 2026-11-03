// SPDX-License-Identifier: AGPL-3.0-only
import { requireOptionalNativeModule } from 'expo';
import { AudioModeController, type FocusState, type NativeAudio } from './mode.ts';

export { type AudioMode, type FocusState, focusGain } from './mode.ts';

interface Native {
  setMode(mode: string): void;
  release(): void;
  addListener(
    event: 'onFocusChange',
    listener: (e: { state: FocusState }) => void,
  ): { remove(): void };
}

// null on iOS (no native side yet) and in a build without the module: the calls do nothing.
const module = requireOptionalNativeModule<Native>('OpenliveAudio');

const native: NativeAudio | null = module
  ? {
      setMode: (mode) => module.setMode(mode),
      release: () => module.release(),
      onFocusChange: (listener) => {
        const sub = module.addListener('onFocusChange', (e) => listener(e.state));
        return () => sub.remove();
      },
    }
  : null;

/** The app's one audio mode. */
export const audio = new AudioModeController(native);

/** `setAudioMode('media')` while watching, `'communication'` while in voice. */
export const setAudioMode = (mode: 'media' | 'communication'): void => audio.setAudioMode(mode);

/** Nothing is playing or talking any more. */
export const releaseAudio = (): void => audio.releaseAudio();

/** The stream player closed: gives media audio back (a voice session in progress keeps its own). */
export const releaseMedia = (): void => audio.releaseMedia();
