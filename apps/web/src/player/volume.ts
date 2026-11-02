// SPDX-License-Identifier: AGPL-3.0-only
// Volume and mute, remembered per streamer: every game and
// microphone sounds different. localStorage for now; the profile keeps it once signed-in sync
// exists. Storage can be missing or full (private windows): reads fall back to the default and
// writes are dropped.

export interface VolumeSetting {
  /** 0–1. */
  volume: number;
  muted: boolean;
}

export const DEFAULT_VOLUME: VolumeSetting = { volume: 0.8, muted: false };
export const VOLUME_STEP = 0.05;
const PREFIX = 'openlive.volume.';

export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_VOLUME.volume;
  return Math.round(Math.min(1, Math.max(0, volume)) * 100) / 100;
}

export function loadVolume(streamerId: string, storage: Storage = localStorage): VolumeSetting {
  try {
    const raw = storage.getItem(PREFIX + streamerId);
    if (!raw) return DEFAULT_VOLUME;
    const value = JSON.parse(raw) as Partial<VolumeSetting>;
    return {
      volume: typeof value.volume === 'number' ? clampVolume(value.volume) : DEFAULT_VOLUME.volume,
      muted: value.muted === true,
    };
  } catch {
    return DEFAULT_VOLUME;
  }
}

export function saveVolume(
  streamerId: string,
  setting: VolumeSetting,
  storage: Storage = localStorage,
): void {
  try {
    storage.setItem(
      PREFIX + streamerId,
      JSON.stringify({ volume: clampVolume(setting.volume), muted: setting.muted }),
    );
  } catch {
    // Not remembered this time.
  }
}

/** Arrow keys: one step up or down; turning the volume up also unmutes. */
export function stepVolume(setting: VolumeSetting, direction: 1 | -1): VolumeSetting {
  const volume = clampVolume(setting.volume + direction * VOLUME_STEP);
  return { volume, muted: direction > 0 ? false : setting.muted };
}
