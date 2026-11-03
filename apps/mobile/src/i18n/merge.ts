// SPDX-License-Identifier: AGPL-3.0-only

export type Texts = { [key: string]: string | Texts };

/** `base` with `extra` laid over it, key by key down the tree (the app's keys win). */
export function mergeTexts(base: Texts, extra: Texts): Texts {
  const out: Texts = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] =
      typeof value === 'object' && typeof current === 'object' ? mergeTexts(current, value) : value;
  }
  return out;
}
