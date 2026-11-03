// SPDX-License-Identifier: AGPL-3.0-only
import { type CameraApi, createCameraApi } from '@openlive/client';
import { webApi } from '../api/client.ts';

// The camera routes of the SFU proxy (PROTOCOL 7.7, 11.2) are @openlive/client's createCameraApi
// on the web's cookie session.

export type { CameraApi };

export const httpCameraApi = (roomId: string): CameraApi => createCameraApi(webApi, roomId);
