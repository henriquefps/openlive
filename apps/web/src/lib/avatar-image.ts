// SPDX-License-Identifier: AGPL-3.0-only

// The profile photo is made in the browser (Settings -> Profile): the chosen picture is cropped to
// a centred square, zoomed in if the person asks, and drawn at 256 x 256 as WebP, so what the API
// stores is small and the same everywhere (apps/api/src/api/avatars.ts).

export const AVATAR_INPUT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** The largest picture accepted before cropping. */
export const MAX_AVATAR_INPUT_BYTES = 5 * 1024 * 1024;

/** The side of the stored photo, in pixels. */
export const AVATAR_SIZE = 256;

export const MAX_ZOOM = 3;

export type AvatarFileProblem = 'type' | 'size';

/** Why a chosen file cannot become a photo, or null when it can. */
export function avatarFileProblem(file: Pick<File, 'type' | 'size'>): AvatarFileProblem | null {
  if (!(AVATAR_INPUT_TYPES as readonly string[]).includes(file.type)) return 'type';
  if (file.size > MAX_AVATAR_INPUT_BYTES) return 'size';
  return null;
}

/** The centred square of a `width` x `height` picture, `zoom` times smaller (1 = the largest). */
export function squareCrop(
  width: number,
  height: number,
  zoom: number,
): { sx: number; sy: number; size: number } {
  const z = Math.min(Math.max(zoom, 1), MAX_ZOOM);
  const size = Math.min(width, height) / z;
  return { sx: (width - size) / 2, sy: (height - size) / 2, size };
}

/** Decodes the chosen file; rejects when the browser cannot read it as an image. */
export function loadImage(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file);
}

/**
 * The 256 x 256 photo. WebP where the browser can encode it; otherwise its PNG fallback, which
 * the API accepts too.
 */
export async function renderAvatar(image: ImageBitmap, zoom: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d canvas');
  const { sx, sy, size } = squareCrop(image.width, image.height, zoom);
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, sx, sy, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.86),
  );
  if (!blob) throw new Error('canvas encoding failed');
  return blob;
}
