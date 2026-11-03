// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiClient } from '../api/client.ts';
import type {
  CameraPublishRequest,
  CameraPublishResponse,
  CameraSubscribeRequest,
  CameraSubscribeResponse,
} from './contract.ts';

// The camera routes of the SFU proxy (PROTOCOL 7.7, 11.2): a client publishes and closes its own
// camera, pulls the others' on the room's one session and switches their layer. The SDP answer to
// a pull's offer goes through the existing PUT .../renegotiate.

export interface CameraApi {
  publish(request: CameraPublishRequest): Promise<CameraPublishResponse>;
  unpublish(sessionId: string): Promise<void>;
  subscribe(request: CameraSubscribeRequest): Promise<CameraSubscribeResponse>;
  /** Every camera pull of the session when `trackIds` is absent. */
  unsubscribe(sessionId: string, trackIds?: string[]): Promise<void>;
  layer(sessionId: string, trackId: string, rid: string): Promise<void>;
}

/** The camera routes of one room on an API client. */
export function createCameraApi(client: ApiClient, roomId: string): CameraApi {
  const base = `/api/rtc/rooms/${encodeURIComponent(roomId)}/camera`;
  const send = client.send;
  return {
    publish: (request) => send<CameraPublishResponse>('POST', `${base}/publish`, request),
    unpublish: (sessionId) => send('POST', `${base}/unpublish`, { sessionId }),
    subscribe: (request) => send<CameraSubscribeResponse>('POST', `${base}/subscribe`, request),
    unsubscribe: (sessionId, trackIds) =>
      send('POST', `${base}/unsubscribe`, trackIds ? { sessionId, trackIds } : { sessionId }),
    layer: (sessionId, trackId, rid) => send('PUT', `${base}/layer`, { sessionId, trackId, rid }),
  };
}
