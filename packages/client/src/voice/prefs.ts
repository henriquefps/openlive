// SPDX-License-Identifier: AGPL-3.0-only
// Voice settings this device remembers: the devices, push-to-talk
// and its key, the "use headphones" hint, and each person's volume. localStorage, like the
// player's volume (player/volume.ts): storage can be missing or full, so reads fall back to the
// defaults and writes are dropped.

export interface VoicePrefs {
  /** The microphone's deviceId; '' is the system default. */
  inputId: string;
  /** The speakers' deviceId (setSinkId); '' is the system default. */
  outputId: string;
  pushToTalk: boolean;
  /** A KeyboardEvent.code. */
  pushToTalkKey: string;
  /** "Use headphones" was dismissed for good. */
  headphonesHintDismissed: boolean;
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  inputId: '',
  outputId: '',
  pushToTalk: false,
  pushToTalkKey: 'KeyV',
  headphonesHintDismissed: false,
};

/** Per-person volume: 0 to 2 (200 %), 1 by default. */
export const DEFAULT_PERSON_VOLUME = 1;
export const MAX_PERSON_VOLUME = 2;

const KEY = 'openlive.voice';
const VOLUME_PREFIX = 'openlive.voice.volume.';

export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The platform's localStorage where there is one (a browser); the app passes its own store. */
function storage(): PrefsStorage | null {
  try {
    return (globalThis as { localStorage?: PrefsStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadPrefs(store: PrefsStorage | null = storage()): VoicePrefs {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return DEFAULT_VOICE_PREFS;
    const value = JSON.parse(raw) as Partial<VoicePrefs>;
    return {
      inputId: typeof value.inputId === 'string' ? value.inputId : DEFAULT_VOICE_PREFS.inputId,
      outputId: typeof value.outputId === 'string' ? value.outputId : DEFAULT_VOICE_PREFS.outputId,
      pushToTalk: value.pushToTalk === true,
      pushToTalkKey:
        typeof value.pushToTalkKey === 'string' && value.pushToTalkKey !== ''
          ? value.pushToTalkKey
          : DEFAULT_VOICE_PREFS.pushToTalkKey,
      headphonesHintDismissed: value.headphonesHintDismissed === true,
    };
  } catch {
    return DEFAULT_VOICE_PREFS;
  }
}

export function savePrefs(prefs: VoicePrefs, store: PrefsStorage | null = storage()): void {
  try {
    store?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered this time.
  }
}

export function clampPersonVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_PERSON_VOLUME;
  return Math.round(Math.min(MAX_PERSON_VOLUME, Math.max(0, volume)) * 100) / 100;
}

export function loadPersonVolume(userId: string, store: PrefsStorage | null = storage()): number {
  try {
    const raw = store?.getItem(VOLUME_PREFIX + userId);
    return raw === null || raw === undefined
      ? DEFAULT_PERSON_VOLUME
      : clampPersonVolume(Number(raw));
  } catch {
    return DEFAULT_PERSON_VOLUME;
  }
}

export function savePersonVolume(
  userId: string,
  volume: number,
  store: PrefsStorage | null = storage(),
): void {
  try {
    store?.setItem(VOLUME_PREFIX + userId, String(clampPersonVolume(volume)));
  } catch {
    // Not remembered this time.
  }
}

/** A key's name for the UI: "KeyV" → "V", "Digit1" → "1", others as they are ("Space"). */
export function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}
