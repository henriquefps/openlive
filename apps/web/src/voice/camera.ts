// SPDX-License-Identifier: AGPL-3.0-only
import {
  type CameraClientOptions as CoreCameraClientOptions,
  type CameraClientState as CoreCameraClientState,
  CameraClient as CoreCameraClient,
  type CameraMedia as CoreCameraMedia,
} from '@openlive/client';

// The camera in the voice channel (PROTOCOL 7.7) is
// @openlive/client's CameraClient (voice/camera.ts there has the story: simulcast, layers, the
// network steps); this binds it to the browser's MediaStreamTrack and localStorage.

export {
  CAMERA_ENCODINGS,
  type CameraError,
  type CameraPhase,
  type CameraPrefs,
  cameraConstraints,
  cameraErrorOf,
  DEFAULT_CAMERA_PREFS,
  type Facing,
  LAYER_HIGH as HIGH,
  LAYER_LOW as LOW,
  loadCameraPrefs,
  type NetworkQuality,
  saveCameraPrefs,
} from '@openlive/client';

export type CameraMedia = CoreCameraMedia<MediaStreamTrack>;
export type CameraClientState = CoreCameraClientState<MediaStreamTrack>;
export type CameraClientOptions = CoreCameraClientOptions<MediaStreamTrack>;

export class CameraClient extends CoreCameraClient<MediaStreamTrack> {}
