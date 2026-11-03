// SPDX-License-Identifier: AGPL-3.0-only
import type { VideoCodec } from '@openlive/protocol';
import { type CapabilitiesOf, CodecPreference, decodesAv1 as decodes } from '@openlive/client';

// Which video codec this browser asks for (protocol 1.14): @openlive/client's
// CodecPreference over RTCRtpReceiver.getCapabilities, with the "AV1 failed" flag kept in
// sessionStorage so a reload of the tab remembers it.

export type { CapabilitiesOf };

const FALLBACK_KEY = 'openlive.av1Fallback';

const browserCapabilities: CapabilitiesOf = (kind) =>
  typeof RTCRtpReceiver !== 'undefined' && typeof RTCRtpReceiver.getCapabilities === 'function'
    ? RTCRtpReceiver.getCapabilities(kind)
    : null;

const preference = new CodecPreference(browserCapabilities, {
  get: () => sessionStorage.getItem(FALLBACK_KEY) === '1',
  set: () => sessionStorage.setItem(FALLBACK_KEY, '1'),
  clear: () => sessionStorage.removeItem(FALLBACK_KEY),
});

/** Whether the browser lists an AV1 decoder for WebRTC. */
export function decodesAv1(capabilities: CapabilitiesOf = browserCapabilities): boolean {
  return decodes(capabilities);
}

/** The codec to ask for: AV1 when the browser decodes it and no AV1 pull failed in this tab. */
export function preferredCodec(capabilities?: CapabilitiesOf): VideoCodec {
  return preference.preferred(capabilities);
}

/** An AV1 pull failed to decode: ask for H.264 for the rest of this tab's life. */
export function noteAv1Failure(): void {
  preference.noteAv1Failure();
}

/** For tests: forget the fallback. */
export function resetAv1Fallback(): void {
  preference.reset();
}
