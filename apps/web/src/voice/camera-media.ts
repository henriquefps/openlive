// SPDX-License-Identifier: AGPL-3.0-only
import { sessionCameraMedia as coreSessionCameraMedia } from '@openlive/client';
import type { RtcSession } from '../rtc/session.ts';
import type { CameraApi } from './camera-api.ts';
import type { CameraMedia } from './camera.ts';

// Cameras on the room's SFU session are @openlive/client's sessionCameraMedia
// (voice/camera-media.ts there) on the browser's tracks.

export const sessionCameraMedia = (session: RtcSession, api: CameraApi): CameraMedia =>
  coreSessionCameraMedia(session, api);
