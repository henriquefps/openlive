// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Progress as ProgressPrimitive } from 'radix-ui';

// Local edit (hfps-app-ui): a `tone` for the indicator. Re-apply after `shadcn add progress`.
const indicatorVariants = cva('size-full flex-1 transition-all', {
  variants: {
    tone: {
      default: 'bg-primary',
      muted: 'bg-muted-foreground',
      warning: 'bg-warning',
      destructive: 'bg-destructive',
    },
  },
  defaultVariants: { tone: 'default' },
});

function Progress({
  className,
  value,
  tone,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & VariantProps<typeof indicatorVariants>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        'relative flex h-1.5 w-full items-center overflow-x-hidden rounded-full bg-muted',
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={indicatorVariants({ tone })}
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
