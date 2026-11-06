// SPDX-License-Identifier: AGPL-3.0-only
import { SLUG_PATTERN, slugify } from './slug.ts';

/** The create-space form as the web's CreateSpaceDialog: the address follows the name until edited. */
export interface SpaceCheck {
  /** The address that will be sent. */
  slug: string;
  slugValid: boolean;
  valid: boolean;
}

export function checkNewSpace(name: string, slug: string | null): SpaceCheck {
  const effective = slug ?? slugify(name);
  const slugValid = SLUG_PATTERN.test(effective);
  return { slug: effective, slugValid, valid: name.trim() !== '' && slugValid };
}

/** Platform setting `spaceCreation`: only an explicit `false` hides the button (older servers omit it). */
export const canCreateSpace = (me: { canCreateSpace?: boolean } | null | undefined): boolean =>
  me?.canCreateSpace !== false;
