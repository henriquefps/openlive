// SPDX-License-Identifier: AGPL-3.0-only
import { MonitorIcon, PauseIcon, UsersIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatBitrate } from '../i18n/format.ts';
import { STATUS_DOT, type StatusTone } from './StatusBadge.tsx';

export type StreamStatus = 'live' | 'paused' | 'failed';

export interface StreamCardProps {
  /** The person streaming. */
  name: string;
  /** Window or screen being captured, when the streamer shares it. */
  source?: string;
  height: number;
  fps: number;
  bitrateBps: number;
  viewers: { used: number; limit: number };
  status: StreamStatus;
  /** The latest snapshot, drawn over the black frame. */
  thumbnailUrl?: string;
  /** Economy mode caps the stream. */
  economy?: boolean;
  /** Opens the watch view; the whole card is the click target. */
  onOpen?: () => void;
  /** The stream shown in the watch view right now. */
  selected?: boolean;
}

const STATUS_TONE: Record<StreamStatus, StatusTone> = {
  live: 'live',
  paused: 'warning',
  failed: 'failed',
};

const PLACEHOLDER_ICON = { live: MonitorIcon, paused: PauseIcon, failed: WarningCircleIcon };

/** A label on the always-black thumbnail (player exception: dark overlay in any theme). */
function ThumbnailPill({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-player/70 px-2 py-0.5 text-xs font-medium text-player-foreground">
      <span aria-hidden className={cn('size-1.5 rounded-full', STATUS_DOT[tone])} />
      {label}
    </span>
  );
}

export function StreamCard({
  name,
  source,
  height,
  fps,
  bitrateBps,
  viewers,
  status,
  thumbnailUrl,
  economy = false,
  onOpen,
  selected = false,
}: StreamCardProps) {
  const { t, i18n } = useTranslation();
  // A thumbnail that fails to load (deleted as the stream paused or ended) shows the placeholder.
  const [broken, setBroken] = useState<string | null>(null);
  const image = thumbnailUrl && thumbnailUrl !== broken ? thumbnailUrl : null;
  const full = viewers.used >= viewers.limit;
  const Placeholder = PLACEHOLDER_ICON[status];
  const meta = t('stream.meta', {
    resolution: t('stream.resolution', { height, fps }),
    bitrate: formatBitrate(bitrateBps, i18n.language),
  });
  return (
    <Card
      size="sm"
      className={cn(
        'relative gap-0 py-0',
        onOpen &&
          'transition-shadow hover:shadow-md has-[button:focus-visible]:ring-3 has-[button:focus-visible]:ring-ring/50',
        selected && 'ring-2 ring-primary',
      )}
      data-status={status}
      data-selected={selected || undefined}
    >
      {/* `dark` scopes the dark tokens: the video area is black in both themes. */}
      <div className="dark relative aspect-video bg-player text-player-foreground">
        {image ? (
          <img
            src={image}
            alt=""
            className="size-full object-contain"
            onError={() => setBroken(image)}
          />
        ) : (
          <div
            className={cn(
              'flex size-full items-center justify-center',
              status === 'failed' ? 'text-destructive' : 'text-player-foreground/50',
            )}
          >
            <Placeholder className="size-8" aria-hidden />
            <span className="sr-only">{t('stream.noPreview')}</span>
          </div>
        )}
        <div className="absolute top-2 left-2 flex gap-1.5">
          <ThumbnailPill tone={STATUS_TONE[status]} label={t(`stream.status.${status}`)} />
          {full && status !== 'failed' && (
            <ThumbnailPill tone="warning" label={t('stream.status.full')} />
          )}
          {economy && status !== 'failed' && (
            <ThumbnailPill tone="warning" label={t('stream.economy')} />
          )}
        </div>
      </div>
      <CardContent className="flex-1 flex-row items-start justify-between gap-3 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="truncate text-base font-medium" title={name}>
            {onOpen ? (
              // Stretched over the card, so a click anywhere opens the stream.
              <button
                type="button"
                onClick={onOpen}
                aria-label={t('stream.watch', { name })}
                aria-current={selected || undefined}
                className="outline-none after:absolute after:inset-0 after:rounded-xl"
              >
                {name}
              </button>
            ) : (
              name
            )}
          </h3>
          {source && <p className="truncate text-[0.8125rem] text-muted-foreground">{source}</p>}
          <p className="font-mono text-[0.8125rem] text-muted-foreground">{meta}</p>
        </div>
        <p
          className={cn(
            'flex shrink-0 items-center gap-1 text-sm tabular-nums',
            full ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          <UsersIcon aria-hidden />
          <span aria-hidden>{t('stream.slots', viewers)}</span>
          <span className="sr-only">{t('stream.slotsLabel', viewers)}</span>
        </p>
      </CardContent>
    </Card>
  );
}
