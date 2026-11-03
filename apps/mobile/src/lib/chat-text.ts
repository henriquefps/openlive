// SPDX-License-Identifier: AGPL-3.0-only
// Same as apps/web/src/chat/text.ts (the web keeps its copy; both could move to @openlive/client).
// A chat message's plain text split into what the panel renders: text, links and mentions. The
// panel turns each piece into React text nodes or an <a>, never HTML, so nothing in a message can
// inject markup (docs/PROTOCOL.md 7.6).

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'mention'; text: string; userId: string };

// http(s) only: no javascript:, data: or other schemes ever become a link.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/giu;
// Punctuation that usually ends a sentence rather than the URL.
const TRAILING = '.,;:!?)]}\'"»”’';

const count = (text: string, ch: string): number => text.split(ch).length - 1;

/** The http(s) URLs in a text, with their positions. */
function links(text: string): { start: number; end: number; href: string }[] {
  const found: { start: number; end: number; href: string }[] = [];
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0];
    for (let last = url.at(-1); last !== undefined && TRAILING.includes(last); last = url.at(-1)) {
      // Keep a closing parenthesis opened inside the URL (Wikipedia links).
      if (last === ')' && count(url, '(') >= count(url, ')')) break;
      url = url.slice(0, -1);
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    found.push({ start: match.index, end: match.index + url.length, href: url });
  }
  return found;
}

const isWordChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

/** The @name mentions of the given people in a text, longest names first, not inside words. */
function mentionRanges(
  text: string,
  people: readonly { userId: string; name: string }[],
): { start: number; end: number; userId: string }[] {
  const lower = text.toLocaleLowerCase();
  const sorted = people
    .filter((p) => p.name.trim() !== '')
    .map((p) => ({ userId: p.userId, name: p.name.trim().toLocaleLowerCase() }))
    .sort((a, b) => b.name.length - a.name.length);
  const ranges: { start: number; end: number; userId: string }[] = [];
  for (const { userId, name } of sorted) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(`@${name}`, from);
      if (at === -1) break;
      from = at + 1;
      const end = at + 1 + name.length;
      if (isWordChar(lower[at - 1]) || isWordChar(lower[end])) continue;
      if (ranges.some((r) => at < r.end && end > r.start)) continue;
      ranges.push({ start: at, end, userId });
    }
  }
  return ranges;
}

/**
 * Splits a message into segments. `mentioned` are the users the room resolved for this message
 * (ChatMessage.mentions) with the names the reader knows them by; only those are highlighted.
 */
export function segments(
  text: string,
  mentioned: readonly { userId: string; name: string }[] = [],
): Segment[] {
  const marks = [
    ...links(text).map((l) => ({ ...l, kind: 'link' as const })),
    ...mentionRanges(text, mentioned).map((m) => ({ ...m, kind: 'mention' as const })),
  ].sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let at = 0;
  for (const mark of marks) {
    // A mention inside a link (or the reverse) stays part of the first one.
    if (mark.start < at) continue;
    if (mark.start > at) out.push({ kind: 'text', text: text.slice(at, mark.start) });
    const piece = text.slice(mark.start, mark.end);
    out.push(
      mark.kind === 'link'
        ? { kind: 'link', text: piece, href: mark.href }
        : { kind: 'mention', text: piece, userId: mark.userId },
    );
    at = mark.end;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

/**
 * The @query being typed just before the caret, for the mention autocomplete: its start and the
 * text after the @ (may be empty). Null when the caret is not in one.
 */
export function mentionQuery(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1 || isWordChar(before[at - 1])) return null;
  const query = before.slice(at + 1);
  // Names may have one space between words, never a line break or two spaces in a row.
  if (/\n| {2}/.test(query) || query.length > 64) return null;
  return { start: at, query };
}
