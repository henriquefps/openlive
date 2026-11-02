// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentProps } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Status tones: ok/active, live (someone streaming now, the only use of --live), attention/paused/full, failure, stopped/idle. */
export type StatusTone = 'ok' | 'live' | 'warning' | 'failed' | 'idle';

export const STATUS_DOT: Record<StatusTone, string> = {
  ok: 'bg-primary',
  live: 'bg-live',
  warning: 'bg-warning',
  failed: 'bg-destructive',
  idle: 'bg-muted-foreground',
};

/** A neutral outline badge whose dot carries the status color; the text says the status. */
export function StatusBadge({
  tone,
  className,
  children,
  ...props
}: ComponentProps<typeof Badge> & { tone: StatusTone }) {
  return (
    <Badge
      variant="outline"
      data-tone={tone}
      className={cn('h-auto min-h-5 whitespace-normal', className)}
      {...props}
    >
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[tone])} />
      {children}
    </Badge>
  );
}
