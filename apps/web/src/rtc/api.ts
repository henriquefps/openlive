// SPDX-License-Identifier: AGPL-3.0-only
import type {
  IceServersResponse,
  LayerRequest,
  RenegotiateResponse,
  SessionDescription,
  SubscribeRequest,
  SubscribeResponse,
  ViewerSessionResponse,
} from '@openlive/protocol';
import { apiSend } from '../api/client.ts';

// The viewer's side of the SFU proxy (docs/PROTOCOL.md 11.2). The Worker makes every Realtime
// call; the browser only ever sees its own session id, the SFU's SDP and the mids of its tracks.

export interface RtcApi {
  ice(): Promise<IceServersResponse>;
  session(offer: SessionDescription | null): Promise<ViewerSessionResponse>;
  subscribe(request: SubscribeRequest): Promise<SubscribeResponse>;
  renegotiate(sessionId: string, answer: SessionDescription): Promise<RenegotiateResponse>;
  layer(request: LayerRequest): Promise<void>;
  unsubscribe(sessionId: string, streamId: string): Promise<void>;
  /**
   * Closes everything pulled on the session. Sent with sendBeacon so it survives the page going
   * away (`pagehide`); the API accepts the body as text/plain.
   */
  leave(sessionId: string): void;
}

export function httpRtcApi(roomId: string): RtcApi {
  const base = `/api/rtc/rooms/${encodeURIComponent(roomId)}`;
  return {
    ice: () => apiSend<IceServersResponse>('POST', `${base}/ice`),
    session: (offer) =>
      apiSend<ViewerSessionResponse>(
        'POST',
        `${base}/session`,
        offer ? { sessionDescription: offer } : {},
      ),
    subscribe: (request) => apiSend<SubscribeResponse>('POST', `${base}/subscribe`, request),
    renegotiate: (sessionId, answer) =>
      apiSend<RenegotiateResponse>('PUT', `${base}/renegotiate`, {
        sessionId,
        sessionDescription: answer,
      }),
    layer: (request) => apiSend('PUT', `${base}/layer`, request),
    unsubscribe: (sessionId, streamId) =>
      apiSend('POST', `${base}/unsubscribe`, { sessionId, streamId }),
    leave: (sessionId) => {
      const body = JSON.stringify({ roomId, sessionId });
      if (
        typeof navigator.sendBeacon === 'function' &&
        navigator.sendBeacon('/api/rtc/leave', body)
      )
        return;
      // No beacon (or its queue is full): a keepalive fetch outlives the page as well.
      void fetch('/api/rtc/leave', {
        method: 'POST',
        body,
        keepalive: true,
        headers: { 'content-type': 'application/json' },
      }).catch(() => undefined);
    },
  };
}
