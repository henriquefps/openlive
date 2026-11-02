// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { MediaFactory } from '../player/media.ts';
import { httpRtcApi } from './api.ts';
import type { PrePuller } from './prepull.ts';
import { RtcSession, type SessionStatus } from './session.ts';
import { RtcSource } from './source.ts';

// The production media factory: every watched stream is an RtcSource on the room's one SFU
// session. The room view owns the session (useRtcSession), so it is connected before a click.

export function rtcMediaFactory(session: RtcSession, prepuller?: PrePuller | null): MediaFactory {
  return ({ stream, slotId }) => {
    // A hover already pulled the stream's low layer on this slot: show it now and switch up to
    // the top layer, where Automatic starts on a desktop (pre-pulls are desktop only), with
    // tracks/update and no renegotiation. A pull still on its way is switched by the player's
    // Automatic policy on its first sample.
    const prepulled = prepuller?.take(stream.streamId, slotId) ?? null;
    let source: RtcSource;
    if (prepulled) {
      source = prepulled.source;
      source.update(stream);
      const top = source.layers[0]?.rid;
      if (top) source.setLayer(top);
    } else {
      source = new RtcSource(session, { stream, slotId });
      source.start();
    }
    return Promise.resolve({
      stream: source.stream,
      source,
      stop: () => {
        if (prepulled && prepuller) prepuller.giveBack(source);
        else source.stop();
      },
      update: (info) => source.update(info),
      suspend: () => source.suspend(),
      resume: () => source.resume(),
      start: prepulled ? 'prepull' : 'click',
    });
  };
}

/**
 * The room's SFU session while the room view is mounted: opened at once, closed with a
 * beacon on unmount and on `pagehide`, opened again when the page comes back from the
 * back/forward cache. With `enabled` false (fake media) nothing is opened.
 */
export function useRtcSession(
  roomId: string,
  enabled: boolean,
): { session: RtcSession; status: SessionStatus } {
  // Creating the session opens nothing; the effect starts and closes it (StrictMode-safe).
  const session = useMemo(() => new RtcSession({ api: httpRtcApi(roomId) }), [roomId]);
  useEffect(() => {
    if (!enabled) return;
    session.start();
    const hide = () => session.close();
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) session.start();
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      session.close();
    };
  }, [session, enabled]);
  const status = useSyncExternalStore(session.subscribe, session.getStatus);
  return { session, status };
}
