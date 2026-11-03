// SPDX-License-Identifier: AGPL-3.0-only
import { XIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { formatBitrate } from '../i18n/format.ts';
import { type DisplayCadence, screenLimit } from './display.ts';
import type { Quality } from './hooks.ts';
import type { Layer } from '@openlive/client';
import type { StatsSample } from '@openlive/client';

/**
 * "Stats for nerds": the last getStats() sample over the video, and the screen's side
 *: its refresh rate, the frames it presents, and a hint when the screen is
 * slower than the stream.
 */
export function StatsOverlay({
  sample,
  layer,
  quality,
  ttffMs,
  display,
  onClose,
}: {
  sample: StatsSample | null;
  layer: Layer | undefined;
  quality: Quality;
  /** Click → first frame (ttff.ts), once measured. */
  ttffMs: number | null;
  display: DisplayCadence;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const number = (value: number | null, digits = 0) =>
    value === null
      ? '–'
      : new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  const ms = (value: number | null) =>
    value === null ? '–' : t('player.stats.ms', { value: number(value, 1) });
  const rows: [string, string][] = sample
    ? [
        [
          t('player.stats.resolution'),
          sample.width !== null && sample.height !== null
            ? `${sample.width}×${sample.height}`
            : '–',
        ],
        [t('player.stats.fpsReceived'), number(sample.fps, 1)],
        [
          t('player.stats.screen'),
          display.screenHz === null
            ? '–'
            : t('player.stats.screenValue', {
                hz: number(display.screenHz),
                shown: number(display.presentedFps),
              }),
        ],
        [
          t('player.stats.bitrate'),
          sample.bitrateBps === null ? '–' : formatBitrate(sample.bitrateBps, locale),
        ],
        [
          t('player.stats.loss'),
          sample.loss === null
            ? '–'
            : new Intl.NumberFormat(locale, {
                style: 'percent',
                maximumFractionDigits: 1,
              }).format(sample.loss),
        ],
        [t('player.stats.jitterBuffer'), ms(sample.jitterBufferMs)],
        [t('player.stats.rtt'), ms(sample.rttMs)],
        [t('player.stats.codec'), sample.codec ?? '–'],
        [
          t('player.stats.layer'),
          layer
            ? `${layer.rid} · ${t('stream.resolution', { height: layer.height, fps: layer.fps })}${
                quality === 'auto' ? ` · ${t('player.quality.auto')}` : ''
              }`
            : '–',
        ],
        [t('player.stats.decode'), ms(sample.decodeMs)],
        [t('player.stats.ttff'), ms(ttffMs)],
        [
          t('player.stats.frames'),
          t('player.stats.framesValue', {
            decoded: number(sample.framesDecoded),
            freezes: number(sample.freezeCount),
            lost: number(sample.packetsLost),
          }),
        ],
        [
          t('player.stats.dropped'),
          t('player.stats.droppedValue', { value: number(sample.newFramesDropped) }),
        ],
      ]
    : [];
  const limitHz = sample ? screenLimit(sample.fps, display.screenHz) : null;
  return (
    <div
      className="absolute top-2 right-2 z-10 max-h-[calc(100%-4.5rem)] max-w-[calc(100%-1rem)] overflow-auto rounded-md bg-player/85 p-3 pr-10 shadow-md ring-1 ring-player-foreground/10 sm:top-3 sm:right-3"
      data-slot="player-stats"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-1.5 right-1.5"
        onClick={onClose}
        aria-label={t('player.stats.close')}
      >
        <XIcon />
      </Button>
      <h3 className="mb-1.5 text-sm font-semibold">{t('player.stats.title')}</h3>
      {sample ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 font-mono text-xs tabular-nums">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-player-foreground/70">{label}</dt>
              <dd className="truncate">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {sample && limitHz !== null && (
        <p
          className="mt-2 max-w-64 text-xs text-player-foreground/80"
          data-slot="player-screen-limit"
        >
          {t('player.stats.screenLimit', { hz: limitHz, fps: Math.round(sample.fps ?? 0) })}
        </p>
      )}
      {sample ? null : (
        <p className="text-xs text-player-foreground/70">{t('player.stats.waiting')}</p>
      )}
    </div>
  );
}
