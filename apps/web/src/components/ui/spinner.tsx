// SPDX-License-Identifier: AGPL-3.0-only
import { SpinnerIcon, type IconProps } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

// Local edit: Phosphor's IconProps (exactOptionalPropertyTypes), and no built-in English label:
// callers pass aria-label, or the spinner sits next to text that says what is loading.
function Spinner({ className, ...props }: IconProps) {
  return (
    <SpinnerIcon
      data-slot="spinner"
      role="status"
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  );
}

export { Spinner };
