// SPDX-License-Identifier: AGPL-3.0-only

// Volume and mute of the watched stream: the audio track's own gain, on top of the phone's media
// volume (its buttons). Not remembered between streams.

export interface VolumeSetting {
  /** 0–1. */
  volume: number;
  muted: boolean;
}

export const DEFAULT_VOLUME: VolumeSetting = { volume: 1, muted: false };
export const VOLUME_STEP = 0.1;

export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_VOLUME.volume;
  return Math.round(Math.min(1, Math.max(0, volume)) * 100) / 100;
}

/** One step up or down; turning it up also unmutes. */
export function stepVolume(setting: VolumeSetting, direction: 1 | -1): VolumeSetting {
  const volume = clampVolume(setting.volume + direction * VOLUME_STEP);
  return { volume, muted: direction > 0 ? false : setting.muted };
}

/** The gain to give the audio tracks. */
export const effectiveVolume = (setting: VolumeSetting): number =>
  setting.muted ? 0 : clampVolume(setting.volume);
