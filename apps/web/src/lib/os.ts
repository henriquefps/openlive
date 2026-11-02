// SPDX-License-Identifier: AGPL-3.0-only
export const DESKTOP_OSES = ['windows', 'macos', 'linux'] as const;
export type DesktopOs = (typeof DESKTOP_OSES)[number];

/** The desktop system a user agent runs on; undefined for phones, tablets and unknown agents. */
export function detectDesktopOs(userAgent: string): DesktopOs | undefined {
  if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return undefined;
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
  if (/Linux|X11|CrOS/i.test(userAgent)) return 'linux';
  return undefined;
}
