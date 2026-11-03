// SPDX-License-Identifier: AGPL-3.0-only

// The profile photo on the phone, by the same rules as the web (apps/web lib/avatar-image.ts): the
// chosen picture is cropped to a centred square and sent as a 256 x 256 photo (WebP, or JPEG
// where the phone cannot encode WebP). The API takes at most 512 KiB (docs/PROTOCOL.md 11.5).

/** The side of the stored photo, in pixels. */
export const AVATAR_SIZE = 256;

/** The largest picture accepted before cropping. */
export const MAX_AVATAR_INPUT_BYTES = 5 * 1024 * 1024;

/** The most the API stores. */
export const MAX_AVATAR_BYTES = 512 * 1024;

/** The same rule as the API's: trimmed, 1 to 80 characters. */
export const DISPLAY_NAME_MAX = 80;

/** The centred square of a `width` x `height` picture. */
export function squareCrop(
  width: number,
  height: number,
): { originX: number; originY: number; width: number; height: number } {
  const side = Math.min(width, height);
  return {
    originX: Math.floor((width - side) / 2),
    originY: Math.floor((height - side) / 2),
    width: side,
    height: side,
  };
}

export type AvatarFileProblem = 'size';

/** Why the picked picture cannot become a photo, or null when it can (size is known on Android). */
export function avatarFileProblem(fileSize: number | undefined): AvatarFileProblem | null {
  return fileSize !== undefined && fileSize > MAX_AVATAR_INPUT_BYTES ? 'size' : null;
}

/** Why a typed name cannot be saved, as the API checks it (trimmed, 1 to 80 characters). */
export function nameProblem(value: string): 'required' | 'tooLong' | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'required';
  if (trimmed.length > DISPLAY_NAME_MAX) return 'tooLong';
  return null;
}

/**
 * Where to load a photo from. An uploaded photo is the instance's own path
 * (`/api/avatars/:userId/:version`) and needs the app token; a Discord photo is an absolute URL
 * and goes as it is, without the token.
 */
export function avatarSource(
  url: string,
  origin: string | null,
  headers: Record<string, string> | null,
): { uri: string; headers?: Record<string, string> } | null {
  if (!url.startsWith('/')) return { uri: url };
  if (!origin || !headers) return null;
  return { uri: origin.replace(/\/+$/, '') + url, headers };
}
