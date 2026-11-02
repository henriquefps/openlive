// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

// Shared Zod pieces for the REST bodies.

/** Same pattern as the protocol's Id. */
export const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** Lowercase letters, digits and inner hyphens, as in /s/friends/r/game-night. */
export const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/);

export const name = z.string().trim().min(1).max(80);
