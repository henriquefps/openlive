// SPDX-License-Identifier: AGPL-3.0-only
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';
import { AVATAR_SIZE, avatarFileProblem, squareCrop } from './lib/avatar.ts';

// Choosing the profile photo: pick one from the gallery or take it with the camera (the system's
// own crop screen, square), then make the 256 x 256 photo the API stores (lib/avatar.ts).

export type PhotoSource = 'gallery' | 'camera';
export const GALLERY: PhotoSource = 'gallery';
export const CAMERA: PhotoSource = 'camera';

/** A photo ready to upload, or why there is none: `cancelled`, `denied` (permission) or a problem. */
export type PhotoResult =
  | { ok: true; uri: string; type: string }
  | { ok: false; reason: 'cancelled' | 'denied' | 'size' | 'unreadable' };

const OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  allowsEditing: true,
  aspect: [1, 1],
  quality: 1,
};

export async function choosePhoto(source: PhotoSource): Promise<PhotoResult> {
  try {
    let picked: ImagePicker.ImagePickerResult;
    if (source === 'camera') {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) return { ok: false, reason: 'denied' };
      picked = await ImagePicker.launchCameraAsync(OPTIONS);
    } else {
      // The system photo picker needs no permission.
      picked = await ImagePicker.launchImageLibraryAsync(OPTIONS);
    }
    const asset = picked.canceled ? undefined : picked.assets[0];
    if (!asset) return { ok: false, reason: 'cancelled' };
    if (avatarFileProblem(asset.fileSize)) return { ok: false, reason: 'size' };
    return await makeAvatar(asset.uri, asset.width, asset.height);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** The centred square of the picture at 256 x 256: WebP on Android, JPEG elsewhere. */
async function makeAvatar(uri: string, width: number, height: number): Promise<PhotoResult> {
  const webp = Platform.OS === 'android';
  const context = ImageManipulator.ImageManipulator.manipulate(uri);
  if (width !== height) context.crop(squareCrop(width, height));
  const image = await context.resize({ width: AVATAR_SIZE, height: AVATAR_SIZE }).renderAsync();
  const saved = await image.saveAsync({
    format: webp ? ImageManipulator.SaveFormat.WEBP : ImageManipulator.SaveFormat.JPEG,
    compress: 0.86,
  });
  return { ok: true, uri: saved.uri, type: webp ? 'image/webp' : 'image/jpeg' };
}

/** The file as the body of the upload, with the type the API checks. */
export async function photoBlob(uri: string, type: string): Promise<Blob> {
  const blob = await (await fetch(uri)).blob();
  return new Blob([blob], { type });
}
