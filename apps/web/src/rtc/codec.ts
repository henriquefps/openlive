// SPDX-License-Identifier: AGPL-3.0-only
import type { VideoCodec } from '@openlive/protocol';

// Which video codec this browser asks for (protocol 1.14). A stream may publish its
// top layer in AV1 beside H.264; the viewer asks for AV1 when its browser can decode it, and the
// Worker answers with the AV1 track for a top-layer pull where the room allows AV1 for the
// stream's preset. A stalled AV1 pull is pulled again in H.264 (rtc/source.ts); when its decoder
// never produced a frame, the tab asks for H.264 from then on.

const FALLBACK_KEY = 'openlive.av1Fallback';

/** The capability query; RTCRtpReceiver.getCapabilities in a browser. */
export type CapabilitiesOf = (kind: 'video') => { codecs: { mimeType: string }[] } | null;

const browserCapabilities: CapabilitiesOf = (kind) =>
  typeof RTCRtpReceiver !== 'undefined' && typeof RTCRtpReceiver.getCapabilities === 'function'
    ? RTCRtpReceiver.getCapabilities(kind)
    : null;

/** Whether the browser lists an AV1 decoder for WebRTC. */
export function decodesAv1(capabilities: CapabilitiesOf = browserCapabilities): boolean {
  return (capabilities('video')?.codecs ?? []).some(
    (c) => c.mimeType.toLowerCase() === 'video/av1',
  );
}

let fellBack = false;

function storedFallback(): boolean {
  try {
    return sessionStorage.getItem(FALLBACK_KEY) === '1';
  } catch {
    return false;
  }
}

/** The codec to ask for: AV1 when the browser decodes it and no AV1 pull failed in this tab. */
export function preferredCodec(capabilities: CapabilitiesOf = browserCapabilities): VideoCodec {
  if (fellBack || storedFallback()) return 'h264';
  return decodesAv1(capabilities) ? 'av1' : 'h264';
}

/** An AV1 pull failed to decode: ask for H.264 for the rest of this tab's life. */
export function noteAv1Failure(): void {
  fellBack = true;
  try {
    sessionStorage.setItem(FALLBACK_KEY, '1');
  } catch {
    // Private mode: the in-memory flag still holds for this page.
  }
}

/** For tests: forget the fallback. */
export function resetAv1Fallback(): void {
  fellBack = false;
  try {
    sessionStorage.removeItem(FALLBACK_KEY);
  } catch {
    // Nothing stored.
  }
}
