// SPDX-License-Identifier: AGPL-3.0-only
import type { PointerShape, PointerStyle } from '@openlive/protocol';
import { cn } from '@/lib/utils';
import { POINTER_COLOR_VALUES } from './style.ts';

// The visual click (docs/PROTOCOL.md 7.9): a pulsing marker of the sender's color and shape with
// their name under it. The same look as the helper draws on the streamer's screen. The pulse is
// motion-safe only: with reduced motion the marker stays still.

function Shape({ shape }: { shape: PointerShape }) {
  switch (shape) {
    case 'dot':
      return <circle cx="12" cy="12" r="6" fill="currentColor" />;
    case 'crosshair':
      return (
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none">
          <circle cx="12" cy="12" r="6" />
          <path d="M12 1v6M12 17v6M1 12h6M17 12h6" />
        </g>
      );
    case 'star':
      return (
        <path
          d="M12 2.5l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 16.8 6.2 20l1.4-6.4-4.9-4.4 6.5-.7z"
          fill="currentColor"
          strokeLinejoin="round"
        />
      );
    case 'ring':
    default:
      return <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="3" fill="none" />;
  }
}

export function PingIndicator({
  style,
  name,
  className,
  position,
}: {
  style: PointerStyle;
  /** Shown under the marker; none in a bare preview. */
  name?: string;
  className?: string;
  /** Percentages of the parent; the marker's centre sits there. Without it, in the flow. */
  position?: { left: number; top: number };
}) {
  const color = POINTER_COLOR_VALUES[style.color];
  return (
    <span
      aria-hidden
      data-slot="ping-indicator"
      data-shape={style.shape}
      data-color={style.color}
      className={cn(
        'pointer-events-none flex flex-col items-center gap-1',
        position && 'absolute -translate-x-1/2 -translate-y-[1.25rem]',
        className,
      )}
      style={{ color, ...(position ? { left: `${position.left}%`, top: `${position.top}%` } : {}) }}
    >
      <span className="relative flex size-10 items-center justify-center">
        <span className="absolute inset-0 rounded-full border-2 border-current opacity-75 motion-safe:animate-ping" />
        <svg
          viewBox="0 0 24 24"
          className="relative size-7 drop-shadow-[0_0_2px_rgb(0_0_0/0.8)]"
          focusable="false"
        >
          <Shape shape={style.shape} />
        </svg>
      </span>
      {name && (
        <span className="max-w-40 truncate rounded-md bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white">
          {name}
        </span>
      )}
    </span>
  );
}
