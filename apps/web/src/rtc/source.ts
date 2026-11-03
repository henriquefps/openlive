// SPDX-License-Identifier: AGPL-3.0-only
import {
  RtcSource as CoreRtcSource,
  type RtcSourceOptions as CoreRtcSourceOptions,
} from '@openlive/client';
import { noteAv1Failure, preferredCodec } from './codec.ts';
import type { RtcSession } from './session.ts';

// One watched stream on the room's SFU session is @openlive/client's RtcSource (rtc/source.ts
// there: pulls, layer switches, retries, the AV1 rules); this binds it to the browser's
// MediaStream and codec choice.

export { presetLayers, RETRY_DELAYS_MS, streamLayers } from '@openlive/client';

export type RtcSourceOptions = Omit<
  CoreRtcSourceOptions<MediaStream, MediaStreamTrack>,
  'createStream' | 'preferredCodec'
> & {
  createStream?: () => MediaStream;
  /** The codec to ask for; rtc/codec.ts's preferredCodec by default (tests pass their own). */
  preferredCodec?: CoreRtcSourceOptions<MediaStream, MediaStreamTrack>['preferredCodec'];
};

export class RtcSource extends CoreRtcSource<MediaStreamTrack, MediaStream> {
  constructor(session: RtcSession, options: RtcSourceOptions) {
    super(session, {
      ...options,
      createStream: options.createStream ?? (() => new MediaStream()),
      preferredCodec: options.preferredCodec ?? (() => preferredCodec()),
      noteAv1Failure,
      // addTrack() fires no event; the player follows the video track through `addtrack`.
      onTracksChanged: (stream) => stream.dispatchEvent(new Event('addtrack')),
    });
  }
}
