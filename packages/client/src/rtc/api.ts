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
import type { ApiClient } from '../api/client.ts';

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
   * Closes everything pulled on the session. On the web sent with sendBeacon so it survives the
   * page going away (`pagehide`); the API accepts the body as text/plain.
   */
  leave(sessionId: string): void;
}

/**
 * The SFU proxy routes of one room (PROTOCOL 11.2) on an API client: the web's cookie session or
 * the app's bearer token. `leave` is the platform's way to tell the Worker the session is gone
 * even when the page or the app is going away (sendBeacon on the web); by default a plain POST.
 */
export function createRtcApi(
  client: ApiClient,
  roomId: string,
  leave?: (sessionId: string) => void,
): RtcApi {
  const base = `/api/rtc/rooms/${encodeURIComponent(roomId)}`;
  const send = client.send;
  return {
    ice: () => send<IceServersResponse>('POST', `${base}/ice`),
    session: (offer) =>
      send<ViewerSessionResponse>(
        'POST',
        `${base}/session`,
        offer ? { sessionDescription: offer } : {},
      ),
    subscribe: (request) => send<SubscribeResponse>('POST', `${base}/subscribe`, request),
    renegotiate: (sessionId, answer) =>
      send<RenegotiateResponse>('PUT', `${base}/renegotiate`, {
        sessionId,
        sessionDescription: answer,
      }),
    layer: (request) => send('PUT', `${base}/layer`, request),
    unsubscribe: (sessionId, streamId) =>
      send('POST', `${base}/unsubscribe`, { sessionId, streamId }),
    leave:
      leave ??
      ((sessionId) => {
        void send('POST', '/api/rtc/leave', { roomId, sessionId }).catch(() => undefined);
      }),
  };
}
