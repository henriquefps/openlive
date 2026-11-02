// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatRetentionDays } from '@openlive/protocol';

// Text chat rules that need no state (docs/PROTOCOL.md 7.6).

/** Longest message, in code points after trimming. */
export const CHAT_MAX_CHARS = 2_000;
/** Sends and edits per person per window. */
export const CHAT_RATE_MAX = 30;
export const CHAT_RATE_WINDOW_MS = 60_000;
export const CHAT_PAGE_DEFAULT = 50;
/** welcome.chat and the room list count unread messages up to this. */
export const CHAT_UNREAD_CAP = 100;
/** Default retention, and the platform's ceiling (question 6). */
export const DEFAULT_CHAT_RETENTION_DAYS: ChatRetentionDays = 30;
export const MAX_CHAT_RETENTION_DAYS: ChatRetentionDays = 90;
export const CHAT_RETENTION_OPTIONS: readonly ChatRetentionDays[] = [0, 7, 30, 90];
const MAX_MENTIONS = 50;
const DAY_MS = 86_400_000;

export const isRetention = (value: unknown): value is ChatRetentionDays =>
  CHAT_RETENTION_OPTIONS.includes(value as ChatRetentionDays);

export const retentionMs = (days: number): number => days * DAY_MS;

// C0 and C1 controls except tab and newline, and the bidi overrides that can disguise a link.
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const UNWANTED = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * The text as stored: line breaks normalized, unwanted control characters removed, trimmed. The
 * caller checks it is not empty and not above CHAT_MAX_CHARS.
 */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(UNWANTED, '').trim();
}

export const charCount = (text: string): number => [...text].length;

const isWordChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

/**
 * The people `text` mentions with @name: every known person whose display name follows an @ (not
 * inside a word) and is not followed by a letter or digit, case-insensitive. Longer names win
 * where they overlap ("@Ana Maria" is Ana Maria, not Ana). The author is never mentioned.
 */
export function parseMentions(
  text: string,
  people: readonly { userId: string; displayName: string }[],
  authorId: string,
): string[] {
  const lower = text.toLocaleLowerCase();
  const candidates = people
    .filter((p) => p.userId !== authorId && p.displayName.trim() !== '')
    .map((p) => ({ userId: p.userId, name: p.displayName.trim().toLocaleLowerCase() }))
    .sort((a, b) => b.name.length - a.name.length);
  const taken: [number, number][] = [];
  const found: string[] = [];
  for (const { userId, name } of candidates) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(`@${name}`, from);
      if (at === -1) break;
      from = at + 1;
      const end = at + 1 + name.length;
      if (isWordChar(lower[at - 1]) || isWordChar(lower[end])) continue;
      if (taken.some(([s, e]) => at < e && end > s)) continue;
      taken.push([at, end]);
      if (!found.includes(userId)) found.push(userId);
      break;
    }
    if (found.length >= MAX_MENTIONS) break;
  }
  return found;
}
