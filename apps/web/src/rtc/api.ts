// SPDX-License-Identifier: AGPL-3.0-only
import { createRtcApi, type RtcApi } from '@openlive/client';
import { webApi } from '../api/client.ts';

// The viewer's side of the SFU proxy (docs/PROTOCOL.md 11.2) is @openlive/client's createRtcApi
// on the web's cookie session; only `leave` is the browser's own.

export type { RtcApi };

export function httpRtcApi(roomId: string): RtcApi {
  return createRtcApi(webApi, roomId, (sessionId) => {
    const body = JSON.stringify({ roomId, sessionId });
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon('/api/rtc/leave', body))
      return;
    // No beacon (or its queue is full): a keepalive fetch outlives the page as well.
    void fetch('/api/rtc/leave', {
      method: 'POST',
      body,
      keepalive: true,
      headers: { 'content-type': 'application/json' },
    }).catch(() => undefined);
  });
}
