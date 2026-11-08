// SPDX-License-Identifier: AGPL-3.0-only
import type {
  BrowserPublishRequest,
  IceServersResponse,
  PublishResponse,
  RenegotiateResponse,
  SessionDescription,
} from '@openlive/protocol';
import { webApi } from '../api/client.ts';

// The browser routes of the SFU proxy (protocol 1.22, docs/PROTOCOL.md 11.2): a web tab publishes
// its own SFU session, like a helper. The thumbnail goes through the helper's route (11.3).

export interface BrowserPublishApi {
  ice(): Promise<IceServersResponse>;
  publish(request: BrowserPublishRequest): Promise<PublishResponse>;
  renegotiate(sfuSessionId: string, offer: SessionDescription): Promise<RenegotiateResponse>;
  unpublish(sfuSessionId: string): Promise<void>;
  /** On pagehide: a beacon (the Worker takes the body as text/plain), else a keepalive fetch. */
  unpublishOnExit(sfuSessionId: string): void;
  thumbnail(streamId: string, image: Blob): Promise<void>;
}

export function browserPublishApi(roomId: string): BrowserPublishApi {
  const base = `/api/rtc/rooms/${encodeURIComponent(roomId)}`;
  return {
    ice: () => webApi.send<IceServersResponse>('POST', `${base}/ice`),
    publish: (request) => webApi.send<PublishResponse>('POST', `${base}/browser/publish`, request),
    renegotiate: (sfuSessionId, offer) =>
      webApi.send<RenegotiateResponse>('PUT', `${base}/browser/publish/renegotiate`, {
        sfuSessionId,
        sessionDescription: offer,
      }),
    unpublish: (sfuSessionId) => webApi.send('POST', `${base}/browser/unpublish`, { sfuSessionId }),
    unpublishOnExit: (sfuSessionId) => {
      const url = `${base}/browser/unpublish`;
      const body = JSON.stringify({ sfuSessionId });
      if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, body)) return;
      void fetch(url, {
        method: 'POST',
        body,
        keepalive: true,
        headers: { 'content-type': 'application/json' },
      }).catch(() => undefined);
    },
    thumbnail: (streamId, image) =>
      webApi.upload('PUT', `${base}/streams/${encodeURIComponent(streamId)}/thumbnail`, image),
  };
}
