// SPDX-License-Identifier: AGPL-3.0-only
import { apiSend } from '../api/client.ts';
import type {
  VoicePublishRequest,
  VoicePublishResponse,
  VoiceSubscribeRequest,
  VoiceSubscribeResponse,
} from './contract.ts';

// The voice routes of the SFU proxy: the web publishes and closes
// its own microphone and pulls the others' on the room's one session. The SDP answer to a pull's
// offer goes through the existing PUT .../renegotiate.

export interface VoiceApi {
  publish(request: VoicePublishRequest): Promise<VoicePublishResponse>;
  unpublish(sessionId: string): Promise<void>;
  subscribe(request: VoiceSubscribeRequest): Promise<VoiceSubscribeResponse>;
  /** Every voice pull of the session when `trackIds` is absent. */
  unsubscribe(sessionId: string, trackIds?: string[]): Promise<void>;
}

export function httpVoiceApi(roomId: string): VoiceApi {
  const base = `/api/rtc/rooms/${encodeURIComponent(roomId)}/voice`;
  return {
    publish: (request) => apiSend<VoicePublishResponse>('POST', `${base}/publish`, request),
    unpublish: (sessionId) => apiSend('POST', `${base}/unpublish`, { sessionId }),
    subscribe: (request) => apiSend<VoiceSubscribeResponse>('POST', `${base}/subscribe`, request),
    unsubscribe: (sessionId, trackIds) =>
      apiSend('POST', `${base}/unsubscribe`, trackIds ? { sessionId, trackIds } : { sessionId }),
  };
}
