// SPDX-License-Identifier: AGPL-3.0-only
import { CHAT_MAX_CHARS, type ChatEntry, charCount } from '@openlive/client';
import type { ChatMessage, Member, You } from '@openlive/protocol';
import { mentionQuery } from './chat-text.ts';

// The chat list's rules that do not need a screen: who may do what to a message, what the
// retention line says, the people a mention can name, and the text after picking one.

export type MessageAction = 'edit' | 'delete' | 'retry' | 'discard';

const confirmed = (m: ChatEntry) => !m.pending && !m.failed;

/** Editing: only your own messages, and only while you may write (a guest in a read-only chat not). */
export function canEdit(message: ChatEntry, you: You | null): boolean {
  return (
    you !== null &&
    confirmed(message) &&
    message.userId === you.userId &&
    you.permissions.canWriteChat !== false
  );
}

/** Deleting: your own messages, or anyone's for a moderator. */
export function canDelete(message: ChatEntry, you: You | null): boolean {
  if (you === null || !confirmed(message)) return false;
  return message.userId === you.userId || you.permissions.canModerate;
}

/** What long-pressing a message offers, in the order shown. */
export function messageActions(message: ChatEntry, you: You | null): MessageAction[] {
  if (message.failed) return ['retry', 'discard'];
  if (message.pending) return [];
  const actions: MessageAction[] = [];
  if (canEdit(message, you)) actions.push('edit');
  if (canDelete(message, you)) actions.push('delete');
  return actions;
}

export const mentionsYou = (message: ChatMessage, selfId: string | null): boolean =>
  selfId !== null && message.mentions.includes(selfId);

/** Newest first: the order of an inverted list, which keeps the newest message above the keyboard. */
export const newestFirst = (messages: readonly ChatEntry[]): ChatEntry[] => [...messages].reverse();

/** The retention line under the chat title: its translation key and count. */
export function retentionLine(
  days: number | undefined,
  quick: boolean,
): { key: 'chat.retention.quick' | 'chat.retention.none' | 'chat.retention.days'; count?: number } {
  if (quick) return { key: 'chat.retention.quick' };
  if (days === 0) return { key: 'chat.retention.none' };
  return { key: 'chat.retention.days', count: days ?? 30 };
}

export interface Person {
  userId: string;
  name: string;
}

/** Present members, then everyone who wrote, once each by user id. */
export function chatPeople(members: readonly Member[], messages: readonly ChatEntry[]): Person[] {
  const seen = new Map<string, string>();
  for (const m of members) seen.set(m.userId, m.displayName);
  for (const m of messages) {
    if (m.userId !== undefined && !seen.has(m.userId) && m.authorName !== '') {
      seen.set(m.userId, m.authorName);
    }
  }
  return [...seen].map(([userId, name]) => ({ userId, name }));
}

/** The people a message mentions, with the names the reader knows them by. */
export function mentioned(message: ChatMessage, people: readonly Person[]): Person[] {
  return people.filter((p) => message.mentions.includes(p.userId));
}

/** People whose name starts the typed query (then ones that contain it), without the reader. */
export function mentionSuggestions(
  people: readonly Person[],
  query: string,
  selfId: string | null,
  limit = 5,
): Person[] {
  const q = query.toLocaleLowerCase();
  const others = people.filter((p) => p.userId !== selfId && p.name.trim() !== '');
  const starts = others.filter((p) => p.name.toLocaleLowerCase().startsWith(q));
  const contains = others.filter(
    (p) => !starts.includes(p) && p.name.toLocaleLowerCase().includes(q),
  );
  return [...starts, ...contains].slice(0, limit);
}

/** The text with the @query before the caret replaced by `@name `; the new caret goes with it. */
export function insertMention(
  value: string,
  caret: number,
  name: string,
): { value: string; caret: number } | null {
  const found = mentionQuery(value, caret);
  if (!found) return null;
  const insert = `@${name} `;
  return {
    value: value.slice(0, found.start) + insert + value.slice(caret),
    caret: found.start + insert.length,
  };
}

/** The counter shows from 80 % of the limit on, so a short message has no clutter. */
export function showCounter(text: string): boolean {
  return charCount(text) >= CHAT_MAX_CHARS * 0.8;
}

export const overLimit = (text: string): boolean => charCount(text) > CHAT_MAX_CHARS;

/** HH:mm in the reader's language, today; with the date for an older message. */
export function messageTime(at: number, now: number, locale: string): string {
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return sameDay
    ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(locale, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}
