// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiClient } from '../api/client.ts';
import type {
  VoicePublishRequest,
  VoicePublishResponse,
  VoiceSubscribeRequest,
  VoiceSubscribeResponse,
} from './contract.ts';

// The voice routes of the SFU proxy: a client publishes and closes
// its own microphone and pulls the others' on the room's one session. The SDP answer to a pull's
// offer goes through the existing PUT .../renegotiate.

export interface VoiceApi {
  publish(request: VoicePublishRequest): Promise<VoicePublishResponse>;
  unpublish(sessionId: string): Promise<void>;
  subscribe(request: VoiceSubscribeRequest): Promise<VoiceSubscribeResponse>;
  /** Every voice pull of the session when `trackIds` is absent. */
  unsubscribe(sessionId: string, trackIds?: string[]): Promise<void>;
}

/** The voice routes of one room on an API client: the web's cookie session or the app's token. */
export function createVoiceApi(client: ApiClient, roomId: string): VoiceApi {
  const base = `/api/rtc/rooms/${encodeURIComponent(roomId)}/voice`;
  const send = client.send;
  return {
    publish: (request) => send<VoicePublishResponse>('POST', `${base}/publish`, request),
    unpublish: (sessionId) => send('POST', `${base}/unpublish`, { sessionId }),
    subscribe: (request) => send<VoiceSubscribeResponse>('POST', `${base}/subscribe`, request),
    unsubscribe: (sessionId, trackIds) =>
      send('POST', `${base}/unsubscribe`, trackIds ? { sessionId, trackIds } : { sessionId }),
  };
}
