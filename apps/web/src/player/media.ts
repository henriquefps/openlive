// SPDX-License-Identifier: AGPL-3.0-only
import type { StreamInfo } from '@openlive/protocol';
import { createContext, useContext, useEffect, useState } from 'react';
import type { PlayerSource } from '@openlive/client';

// Where the watch view gets its media once it holds a viewer slot: the rtc client (rtc/media.ts,
// the room's SFU session with a pull per stream) in production, or the fake source
// behind the `fake` flag in development builds.

export interface WatchMedia {
  stream: MediaStream;
  source: PlayerSource;
  /** Stops pulling: the slot is released separately, through the room socket. */
  stop(): void;
  /** The room's latest details of the stream (pause, preset), while it is watched. */
  update?(stream: StreamInfo): void;
  /** Brake 5 (player/brakes.ts): stop receiving while keeping the slot, then pull again. */
  suspend?(): void;
  resume?(): void;
  /** Taken over from a hover pre-pull (rtc/prepull.ts) rather than pulled on the click. */
  start?: 'click' | 'prepull';
}

export interface MediaRequest {
  roomId: string;
  stream: StreamInfo;
  slotId: string;
}

export type MediaFactory = (request: MediaRequest) => Promise<WatchMedia>;

export const MediaFactoryContext = createContext<MediaFactory | null>(null);

/**
 * Development builds: the fake source, loaded on demand. A production build folds this to null
 * and drops the fake source's chunk (the same pattern as the /dev routes).
 */
export const fakeMediaFactory: MediaFactory | null =
  import.meta.env.MODE === 'production'
    ? null
    : async ({ stream }) => {
        const { FakeSource } = await import('./dev/fake-source.ts');
        const source = new FakeSource(stream.source.label, { audio: stream.hasAudio });
        return { stream: source.stream, source, stop: () => source.stop() };
      };

/** The media for one stream while the slot is held; null before, or without a factory. */
export function useWatchMedia(request: MediaRequest | null): WatchMedia | null {
  const factory = useContext(MediaFactoryContext);
  const [media, setMedia] = useState<{ key: string; media: WatchMedia } | null>(null);
  const key = request ? `${request.roomId}/${request.stream.streamId}/${request.slotId}` : null;
  useEffect(() => {
    if (!factory || !request || key === null) return;
    let cancelled = false;
    let created: WatchMedia | null = null;
    factory(request)
      .then((result) => {
        created = result;
        if (cancelled) result.stop();
        else setMedia({ key, media: result });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      created?.stop();
    };
    // `request` is described by `key`; a new object with the same key is the same request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factory, key]);
  const current = media && media.key === key ? media.media : null;
  const stream = request?.stream ?? null;
  useEffect(() => {
    if (current && stream) current.update?.(stream);
  }, [current, stream]);
  return current;
}
