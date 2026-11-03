// SPDX-License-Identifier: AGPL-3.0-only
import type { VideoCodec } from '@openlive/protocol';

// Which video codec this device asks for (protocol 1.14). A stream may publish its
// top layer in AV1 beside H.264; the viewer asks for AV1 when its device can decode it, and the
// Worker answers with the AV1 track for a top-layer pull where the room allows AV1 for the
// stream's preset. A stalled AV1 pull is pulled again in H.264 (rtc/source.ts); when its decoder
// never produced a frame, the device asks for H.264 from then on. The capability query
// (RTCRtpReceiver.getCapabilities, in a browser or in react-native-webrtc, where it lists the
// MediaCodec decoders) and where the fallback is remembered are the platform's.

/** The capability query; RTCRtpReceiver.getCapabilities of the platform. */
export type CapabilitiesOf = (kind: 'video') => { codecs: { mimeType: string }[] } | null;

/** Where the "AV1 failed on this device" flag lives (sessionStorage on the web). */
export interface FallbackStore {
  get(): boolean;
  set(): void;
  clear(): void;
}

/** Whether the capability list holds an AV1 decoder. */
export function decodesAv1(capabilities: CapabilitiesOf): boolean {
  return (capabilities('video')?.codecs ?? []).some(
    (c) => c.mimeType.toLowerCase() === 'video/av1',
  );
}

/** The codec choice of one device: AV1 when it decodes it and no AV1 pull failed before. */
export class CodecPreference {
  private fellBack = false;

  constructor(
    private readonly capabilities: CapabilitiesOf,
    private readonly store?: FallbackStore,
  ) {}

  /** The codec to ask for. */
  preferred(capabilities: CapabilitiesOf = this.capabilities): VideoCodec {
    if (this.fellBack || this.stored()) return 'h264';
    return decodesAv1(capabilities) ? 'av1' : 'h264';
  }

  /** An AV1 pull failed to decode: ask for H.264 from now on. */
  noteAv1Failure(): void {
    this.fellBack = true;
    try {
      this.store?.set();
    } catch {
      // The in-memory flag still holds.
    }
  }

  /** For tests: forget the fallback. */
  reset(): void {
    this.fellBack = false;
    try {
      this.store?.clear();
    } catch {
      // Nothing stored.
    }
  }

  private stored(): boolean {
    try {
      return this.store?.get() ?? false;
    } catch {
      return false;
    }
  }
}
