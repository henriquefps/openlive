// SPDX-License-Identifier: AGPL-3.0-only

// Voice settings this browser remembers are @openlive/client's
// (voice/prefs.ts there, on localStorage when the platform has one).

export {
  clampPersonVolume,
  DEFAULT_PERSON_VOLUME,
  DEFAULT_VOICE_PREFS as DEFAULT_PREFS,
  keyLabel,
  loadPersonVolume,
  loadPrefs,
  MAX_PERSON_VOLUME,
  type PrefsStorage,
  savePersonVolume,
  savePrefs,
  type VoicePrefs,
} from '@openlive/client';
