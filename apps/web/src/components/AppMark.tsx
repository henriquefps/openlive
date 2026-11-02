// SPDX-License-Identifier: AGPL-3.0-only
import { BroadcastIcon } from '@phosphor-icons/react';

/** The app glyph: an olive square with a white broadcast mark (hfps-repo-assets look). */
export function AppMark() {
  return (
    <span
      aria-hidden
      className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground"
    >
      <BroadcastIcon weight="bold" className="size-4" />
    </span>
  );
}
