// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * Wraps a disabled control with a "Coming soon" tooltip. Disabled buttons get no pointer or
 * focus events, so the focusable wrapper carries the tooltip.
 */
export function ComingSoon({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            'inline-flex rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
            className,
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{t('common.comingSoon')}</TooltipContent>
    </Tooltip>
  );
}
