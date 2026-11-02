// SPDX-License-Identifier: AGPL-3.0-only
import {
  ArrowCircleUpIcon,
  EyeSlashIcon,
  HourglassIcon,
  LockIcon,
  PauseIcon,
  PlugsIcon,
  StopCircleIcon,
  UsersIcon,
  WifiSlashIcon,
  type Icon,
} from '@phosphor-icons/react';
import type { PauseReason, StreamEndReason } from '@openlive/protocol';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useNow } from '../hooks/use-now.ts';
import type { WatchAccess } from '../room/connection.ts';
import type { ScreenKind } from './screens.ts';

/** How long a queue offer lasts (PROTOCOL 7.3), for the countdown bar. */
export const OFFER_MS = 30_000;

export interface StateScreenProps {
  kind: Exclude<ScreenKind, 'live' | 'unstable'>;
  streamerName: string;
  pauseReason: PauseReason | null;
  endedReason: StreamEndReason | null;
  access: WatchAccess | null;
  viewers: { used: number; limit: number; queueLength: number } | null;
  onRetry: () => void;
  onJoinQueue: () => void;
  onLeaveQueue: () => void;
  onAccept: () => void;
  /** "Back to the room" and similar, where the screen is a dead end. */
  exit?: ReactNode;
}

type Tone = 'neutral' | 'warning' | 'destructive';

const LOOK: Record<StateScreenProps['kind'], { icon: Icon | null; tone: Tone }> = {
  connecting: { icon: null, tone: 'neutral' },
  paused: { icon: PauseIcon, tone: 'warning' },
  curtain: { icon: EyeSlashIcon, tone: 'warning' },
  reconnecting: { icon: WifiSlashIcon, tone: 'warning' },
  ended: { icon: StopCircleIcon, tone: 'neutral' },
  noPermission: { icon: LockIcon, tone: 'destructive' },
  roomExpired: { icon: HourglassIcon, tone: 'neutral' },
  helperOffline: { icon: PlugsIcon, tone: 'warning' },
  helperOutdated: { icon: ArrowCircleUpIcon, tone: 'destructive' },
  full: { icon: UsersIcon, tone: 'warning' },
};

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'text-player-foreground/70',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

/** The full-size explanation over the black video area when there is no picture to show. */
export function StateScreen(props: StateScreenProps) {
  const { t } = useTranslation();
  const { kind, streamerName: name } = props;
  const { icon: StateIcon, tone } = LOOK[kind];
  const title = t(`player.screen.${kind}.title`, { name });
  let description: string = t(`player.screen.${kind}.description`, { name });
  if (kind === 'paused' && props.pauseReason === 'source_hidden') {
    description = t('player.screen.paused.sourceHidden', { name });
  }
  if (kind === 'ended' && props.endedReason) {
    description = t(`player.endReason.${props.endedReason}`, { name });
  }

  return (
    <div
      role="status"
      data-screen={kind}
      className="absolute inset-0 flex items-center justify-center overflow-y-auto bg-player px-4 pt-4 pb-14 text-center sm:px-6"
    >
      <div className="flex max-w-md flex-col items-center gap-2 sm:gap-3">
        {StateIcon ? (
          <StateIcon aria-hidden className={cn('size-8 sm:size-10', TONE_CLASS[tone])} />
        ) : (
          <Spinner aria-hidden className="size-8 text-player-foreground/70" />
        )}
        <h3 className="text-base font-semibold sm:text-lg">{title}</h3>
        <p
          className={cn(
            'text-sm text-player-foreground/75 sm:text-[0.9375rem]',
            // On a phone the queue's own lines say enough; keep the room for its buttons.
            kind === 'full' && 'hidden sm:block',
          )}
        >
          {description}
        </p>
        {kind === 'full' && <FullActions {...props} />}
        {kind === 'reconnecting' && (
          <Button variant="outline" onClick={props.onRetry} className="mt-1">
            {t('player.retryNow')}
          </Button>
        )}
        {(kind === 'ended' ||
          kind === 'noPermission' ||
          kind === 'roomExpired' ||
          kind === 'helperOffline' ||
          kind === 'helperOutdated') &&
          props.exit && <div className="mt-1">{props.exit}</div>}
      </div>
    </div>
  );
}

/** The slot queue (PROTOCOL 7.3): join, wait in line, take the offered slot. */
function FullActions({ access, viewers, onJoinQueue, onLeaveQueue, onAccept }: StateScreenProps) {
  const { t } = useTranslation();
  const now = useNow(250);
  const slots = viewers ? (
    <p className="font-mono text-[0.8125rem] text-player-foreground/75 tabular-nums">
      {t('player.queue.slots', { used: viewers.used, limit: viewers.limit })}
    </p>
  ) : null;

  if (access?.kind === 'offer') {
    const left = Math.max(0, access.expiresAt - now);
    return (
      <div className="mt-1 flex w-full max-w-xs flex-col items-center gap-3" data-queue="offer">
        <p className="text-[0.9375rem] font-medium text-player-foreground">
          {t('player.queue.offer')}
        </p>
        <Progress
          value={(left / OFFER_MS) * 100}
          tone="warning"
          aria-label={t('player.queue.offerLeft', { seconds: Math.ceil(left / 1000) })}
        />
        <p className="text-[0.8125rem] text-player-foreground/75 tabular-nums">
          {t('player.queue.offerLeft', { seconds: Math.ceil(left / 1000) })}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={onAccept}>{t('player.queue.accept')}</Button>
          <Button variant="outline" onClick={onLeaveQueue}>
            {t('player.queue.decline')}
          </Button>
        </div>
      </div>
    );
  }
  const queue = access?.kind === 'full' ? access.queue : null;
  if (queue === 'joining') {
    return (
      <div className="mt-1 flex flex-col items-center gap-2" data-queue="joining">
        {slots}
        <Spinner aria-label={t('player.queue.joining')} />
      </div>
    );
  }
  if (queue) {
    return (
      <div className="mt-1 flex flex-col items-center gap-3" data-queue="waiting">
        {slots}
        <p className="text-[0.9375rem] font-medium text-player-foreground tabular-nums">
          {t('player.queue.position', { position: queue.position, length: queue.length })}
        </p>
        <Button variant="outline" onClick={onLeaveQueue}>
          {t('player.queue.leave')}
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-1 flex flex-col items-center gap-3" data-queue="none">
      {slots}
      <Button onClick={onJoinQueue}>{t('player.queue.join')}</Button>
      <p className="text-[0.8125rem] text-player-foreground/75">{t('player.queue.joinHint')}</p>
    </div>
  );
}
