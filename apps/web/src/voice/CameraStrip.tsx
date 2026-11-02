// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowsInIcon, MicrophoneSlashIcon } from '@phosphor-icons/react';
import type { Member } from '@openlive/protocol';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CameraClient, CameraClientState } from './camera.ts';
import type { VoiceParticipant } from './contract.ts';

// The camera strip: small tiles near the player, one per person
// in voice, with their camera on the low layer, or their avatar while it is off. Clicking a camera
// enlarges it (the high layer) above the strip; the stream stays the centre of the room. On phones
// the strip scrolls sideways. Video elements are muted: voices play through the voice client.

export interface CameraStripProps {
  participants: readonly VoiceParticipant[];
  members: readonly Member[];
  selfId: string;
  /** Who is speaking now, by user id (the voice client's ring). */
  speaking: Record<string, boolean>;
  client: CameraClient | null;
  state: CameraClientState;
  className?: string;
}

/** A <video> playing one track (srcObject), muted and inline (phones). */
export function CameraVideo({ track, mirror }: { track: MediaStreamTrack; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = new MediaStream([track]);
    void video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      muted
      playsInline
      className={cn('size-full object-cover', mirror && '-scale-x-100')}
    />
  );
}

export function CameraStrip({
  participants,
  members,
  selfId,
  speaking,
  client,
  state,
  className,
}: CameraStripProps) {
  const { t } = useTranslation();
  const who = (userId: string) => members.find((m) => m.userId === userId);
  const nameOf = (userId: string) =>
    userId === selfId ? t('voice.camera.you') : (who(userId)?.displayName ?? t('player.someone'));
  const anyCamera = state.preview !== null || participants.some((p) => p.camera === true);
  if (!anyCamera) return null;
  const enlarged = state.enlarged;
  const enlargedTrack = enlarged === null ? undefined : state.remote[enlarged];
  return (
    <section
      className={cn('flex min-w-0 flex-col gap-2', className)}
      aria-label={t('voice.camera.strip')}
      data-testid="camera-strip"
    >
      {enlarged !== null && enlargedTrack && (
        <div
          className="relative aspect-video w-full max-w-xl overflow-hidden rounded-lg border bg-muted"
          data-testid="camera-enlarged"
          data-user={enlarged}
        >
          <CameraVideo track={enlargedTrack} />
          <span className="absolute bottom-2 left-2 rounded bg-background/80 px-1.5 py-0.5 text-[0.8125rem]">
            {nameOf(enlarged)}
          </span>
          <Button
            variant="secondary"
            size="icon-sm"
            className="absolute top-2 right-2"
            aria-label={t('voice.camera.shrink')}
            onClick={() => client?.enlarge(null)}
          >
            <ArrowsInIcon />
          </Button>
        </div>
      )}
      <ul className="flex gap-2 overflow-x-auto pb-1">
        {participants.map((p) => {
          const self = p.userId === selfId;
          const track = self ? state.preview : state.remote[p.userId];
          const name = nameOf(p.userId);
          const member = who(p.userId);
          const tile = (
            <>
              {track ? (
                <CameraVideo track={track} mirror={self && state.facing === 'user'} />
              ) : (
                <span className="flex size-full items-center justify-center">
                  <Avatar>
                    {member?.avatarUrl && <AvatarImage src={member.avatarUrl} alt="" />}
                    <AvatarFallback>
                      {(member?.displayName ?? name).slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </span>
              )}
              <span className="absolute bottom-1 left-1 flex max-w-[calc(100%-0.5rem)] items-center gap-1 rounded bg-background/80 px-1 text-[0.75rem]">
                <span className="truncate">{name}</span>
                {(p.muted || p.serverMuted) && (
                  <MicrophoneSlashIcon aria-label={t('voice.state.muted')} role="img" />
                )}
              </span>
            </>
          );
          return (
            <li key={p.userId} data-testid="camera-tile" data-user={p.userId}>
              {track && !self ? (
                <button
                  type="button"
                  className={cn(
                    'relative block aspect-video w-32 shrink-0 overflow-hidden rounded-md border bg-muted sm:w-36',
                    speaking[p.userId] && 'ring-2 ring-primary',
                    enlarged === p.userId && 'outline-2 outline-primary',
                  )}
                  aria-label={t('voice.camera.enlarge', { name })}
                  aria-pressed={enlarged === p.userId}
                  onClick={() => client?.enlarge(enlarged === p.userId ? null : p.userId)}
                >
                  {tile}
                </button>
              ) : (
                <div
                  className={cn(
                    'relative block aspect-video w-32 shrink-0 overflow-hidden rounded-md border bg-muted sm:w-36',
                    speaking[p.userId] && 'ring-2 ring-primary',
                    enlarged === p.userId && 'outline-2 outline-primary',
                  )}
                >
                  {tile}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
