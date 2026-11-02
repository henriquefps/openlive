// SPDX-License-Identifier: AGPL-3.0-only
// Above 100 %, a voice goes through WebAudio instead of its <audio> element (audio.ts), and the
// browser's echo cancellation may not cover that path. With headphones that does not matter; on
// speakers the boosted voice can come back through the microphone. Browsers only say a device's
// name, so the guess is by name, and a name that says neither counts as speakers (warn).

export type OutputKind = 'headphones' | 'speakers' | 'unknown';

const HEADPHONES = /head ?(phone|set)|fone|earphone|buds|airpods|in-ear|auricular/i;
const SPEAKERS = /speaker|alto-?falante|caixa de som|hdmi|displayport|monitor|built-in|interno/i;

export function outputKind(label: string | undefined): OutputKind {
  if (!label) return 'unknown';
  if (HEADPHONES.test(label)) return 'headphones';
  if (SPEAKERS.test(label)) return 'speakers';
  return 'unknown';
}

/**
 * The chosen output's name. The system default ('') is the `default` entry, which Chrome names
 * after the real device ("Default - AirPods"); a browser without one gives no name.
 */
export function outputLabel(
  devices: readonly Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[],
  outputId: string,
): string | undefined {
  const id = outputId || 'default';
  return devices.find((d) => d.kind === 'audiooutput' && d.deviceId === id)?.label || undefined;
}

/** Warn when a voice is boosted above 100 % and the output may not be headphones. */
export function warnBoost(volume: number, label: string | undefined): boolean {
  return volume > 1 && outputKind(label) !== 'headphones';
}
