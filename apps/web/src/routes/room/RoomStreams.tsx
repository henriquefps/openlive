// SPDX-License-Identifier: AGPL-3.0-only
import { GlobeIcon, SquaresFourIcon, UsersIcon, XIcon } from '@phosphor-icons/react';
import type { Preset, StreamInfo } from '@openlive/protocol';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ComingSoon } from '../../components/ComingSoon.tsx';
import type { StreamCardProps } from '../../components/StreamCard.tsx';
import { meQuery } from '../../api/auth.ts';
import { flag } from '../../lib/flags.ts';
import { useViewerBrakes } from '../../player/brakes.ts';
import { useWatchMedia } from '../../player/media.ts';
import { StillWatchingDialog } from '../../player/StillWatchingDialog.tsx';
import type { PointerSocket } from '../../pointer/socket.ts';
import type { RoomState } from '../../room/connection.ts';
import type { WatchActions } from '../../room/socket-api.ts';

// The player, its hooks and the stats code load only when someone opens a stream.
const Player = lazy(() => import('../../player/Player.tsx'));

/**
 * Nominal top layer per preset, for the card's meta line when the helper does not
 * report its layers (before protocol 1.19).
 */
export const PRESET_NOMINAL: Record<Preset, { height: number; fps: number; bitrateBps: number }> = {
  text: { height: 1080, fps: 30, bitrateBps: 8_000_000 },
  game: { height: 1080, fps: 60, bitrateBps: 12_000_000 },
  max: { height: 1440, fps: 60, bitrateBps: 18_000_000 },
  native: { height: 2160, fps: 60, bitrateBps: 25_000_000 },
  game120: { height: 1080, fps: 120, bitrateBps: 14_000_000 },
  max120: { height: 1440, fps: 120, bitrateBps: 20_000_000 },
};

export function viewersOf(
  state: RoomState,
  stream: StreamInfo,
): { used: number; limit: number; queueLength: number } {
  const viewers = state.viewers[stream.streamId];
  return viewers
    ? { used: viewers.used, limit: viewers.limit, queueLength: viewers.queueLength }
    : { used: stream.viewerCount, limit: stream.viewerLimit, queueLength: 0 };
}

export const thumbnailUrl = (streamId: string, version: number): string =>
  `/api/streams/${encodeURIComponent(streamId)}/thumbnail?v=${version}`;

/** The room state's streams as stream cards, oldest first. */
export function streamCards(
  state: RoomState,
  unknownName: string,
): (StreamCardProps & { id: string })[] {
  return [...state.streams]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((stream) => {
      // What the helper encodes when it says so (protocol 1.19), the preset's nominal top layer
      // otherwise: a native stream of a 3440x1440 monitor is 1440p, not 2160p.
      const top = stream.layers?.[0];
      const nominal = top
        ? { height: top.height, fps: top.fps, bitrateBps: top.kbps * 1000 }
        : PRESET_NOMINAL[stream.preset];
      const viewers = viewersOf(state, stream);
      return {
        id: stream.streamId,
        name: state.members.find((m) => m.userId === stream.userId)?.displayName ?? unknownName,
        source: stream.source.label,
        height: nominal.height,
        fps: nominal.fps,
        bitrateBps: nominal.bitrateBps,
        viewers: { used: viewers.used, limit: viewers.limit },
        status: stream.paused ? 'paused' : 'live',
        // The snapshot every 10 s: no video, no slot. The version busts the
        // browser's private cache; the URL itself grants nothing.
        ...(stream.thumbnailAt !== undefined
          ? { thumbnailUrl: thumbnailUrl(stream.streamId, stream.thumbnailAt) }
          : {}),
        ...(stream.qualityCap ? { economy: true } : {}),
        ...(stream.origin === 'browser' ? { browser: true } : {}),
      };
    });
}

/** The watch view inside the room page: the player, who is streaming, who is watching. */
export function WatchPanel({
  roomId,
  state,
  streamId,
  actions,
  theater,
  onTheaterChange,
  onClose,
  pointer = null,
}: {
  roomId: string;
  state: RoomState;
  streamId: string;
  actions: WatchActions;
  /** Visual pointer pings on the room socket (PROTOCOL 7.9). */
  pointer?: PointerSocket | null;
  theater: boolean;
  onTheaterChange: (theater: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const live = state.streams.find((s) => s.streamId === streamId) ?? null;
  // Keep the last known details for the ended screen once the stream leaves the list.
  const [last, setLast] = useState(live);
  if (live && live !== last) setLast(live);
  const info = live ?? last;
  const [multiview] = useState(() => flag('multiview'));

  const { watch, unwatch } = actions;
  useEffect(() => {
    watch(streamId);
    return () => unwatch(streamId);
  }, [watch, unwatch, streamId]);

  const access = state.access[streamId] ?? null;
  const media = useWatchMedia(
    live && access?.kind === 'granted' ? { roomId, stream: live, slotId: access.slotId } : null,
  );
  // Brakes 5 and 6: on unless the instance turned them off.
  const { data: me } = useQuery(meQuery);
  const brakes = useViewerBrakes(
    media,
    me?.viewerBrakes ?? { backgroundPause: true, idleCheck: true },
    onClose,
  );
  const name =
    state.members.find((m) => m.userId === info?.userId)?.displayName ?? t('player.someone');
  const viewers = live ? viewersOf(state, live) : null;
  const watchers = (state.viewers[streamId]?.viewerUserIds ?? [])
    .map((id) => state.members.find((m) => m.userId === id)?.displayName)
    .filter((n): n is string => !!n);

  const metrics = media ? { roomId, start: media.start ?? ('click' as const) } : null;

  // Visual clicks: on someone else's stream that allows them, while holding a slot.
  const canPing =
    pointer !== null &&
    live?.pings === true &&
    !live.paused &&
    access?.kind === 'granted' &&
    live.userId !== state.you?.userId;
  // Too many clicks: one toast that updates in place, never a pile of them.
  useEffect(
    () =>
      pointer?.onRejected((rejection) => {
        if (rejection.kind === 'rate_limited') {
          toast(t('pointer.rateLimited'), { id: 'pointer-rate-limited', duration: 2_000 });
        }
      }),
    [pointer, t],
  );

  const close = (
    <Button variant="outline" onClick={onClose}>
      {t('player.backToRoom')}
    </Button>
  );

  return (
    <section className="flex flex-col gap-3" aria-label={t('player.label', { name })}>
      <Suspense fallback={<div className="dark aspect-video w-full rounded-xl bg-player" />}>
        <Player
          stream={media?.stream ?? null}
          source={media?.source ?? null}
          room={{ status: state.status, ended: state.ended }}
          streamInfo={live}
          endedReason={state.endedStreams[streamId] ?? null}
          access={access}
          streamer={{ userId: info?.userId ?? streamId, name }}
          hasAudio={info?.hasAudio ?? false}
          viewers={viewers}
          theater={theater}
          onTheaterChange={onTheaterChange}
          onJoinQueue={() => actions.joinQueue(streamId)}
          onLeaveQueue={() => actions.leaveQueue(streamId)}
          onAccept={() => actions.acceptOffer(streamId)}
          onRetry={() => {
            if (access?.kind === 'denied') watch(streamId);
          }}
          exit={close}
          metrics={metrics}
          pointer={
            canPing ? { onPing: (x, y, style) => pointer.ping(streamId, x, y, style) } : null
          }
        />
      </Suspense>
      <StillWatchingDialog
        idle={brakes.idle}
        onContinue={brakes.confirmWatching}
        onStop={onClose}
      />
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate text-lg font-semibold">{name}</h2>
          {info && (
            <p className="flex min-w-0 items-center gap-2 text-[0.8125rem] text-muted-foreground">
              <span className="truncate">
                {info.source.label} · {t(`presets.${info.preset}`)}
              </span>
              {info.origin === 'browser' && (
                <Badge variant="outline" title={t('stream.browserHint')}>
                  <GlobeIcon aria-hidden />
                  {t('stream.browser')}
                </Badge>
              )}
            </p>
          )}
          {viewers && (
            <p className="flex items-center gap-1 text-[0.8125rem] text-muted-foreground tabular-nums">
              <UsersIcon aria-hidden />
              {t('stream.slotsLabel', { used: viewers.used, limit: viewers.limit })}
              {watchers.length > 0 && ` · ${watchers.join(', ')}`}
              {viewers.queueLength > 0 &&
                ` · ${t('player.queue.waiting', { count: viewers.queueLength })}`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {multiview && (
            <ComingSoon>
              <Button variant="outline" disabled>
                <SquaresFourIcon data-icon="inline-start" />
                {t('player.multiview')}
                <Badge variant="outline">{t('common.comingSoon')}</Badge>
              </Button>
            </ComingSoon>
          )}
          <Button variant="outline" onClick={onClose}>
            <XIcon data-icon="inline-start" />
            {t('player.close')}
          </Button>
        </div>
      </div>
    </section>
  );
}
