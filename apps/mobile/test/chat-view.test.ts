// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatEntry } from '@openlive/client';
import type { Member, You } from '@openlive/protocol';
import { describe, expect, it } from 'vitest';
import {
  canDelete,
  canEdit,
  chatPeople,
  insertMention,
  mentionSuggestions,
  mentionsYou,
  messageActions,
  messageTime,
  newestFirst,
  retentionLine,
} from '../src/lib/chat-view.ts';
import { segments } from '../src/lib/chat-text.ts';

const you = (over: Partial<You['permissions']> = {}, userId = 'me'): You => ({
  userId,
  connectionId: 'c1',
  role: 'member',
  permissions: { canStream: false, canModerate: false, canWriteChat: true, ...over },
});

const msg = (
  id: string,
  userId: string | undefined,
  extra: Partial<ChatEntry> = {},
): ChatEntry => ({
  id,
  ...(userId ? { userId } : {}),
  authorName: userId ?? '',
  text: 'hi',
  createdAt: 1,
  mentions: [],
  ...extra,
});

describe('message actions', () => {
  it('lets you edit and delete your own, only delete others as a moderator', () => {
    expect(messageActions(msg('m_1', 'me'), you())).toEqual(['edit', 'delete']);
    expect(messageActions(msg('m_2', 'other'), you())).toEqual([]);
    expect(messageActions(msg('m_2', 'other'), you({ canModerate: true }))).toEqual(['delete']);
  });

  it('does not let a read-only guest edit', () => {
    expect(canEdit(msg('m_1', 'me'), you({ canWriteChat: false }))).toBe(false);
  });

  it('offers retry and discard for a failed message and nothing while pending', () => {
    expect(messageActions(msg('p', 'me', { failed: { code: 'internal_error' } }), you())).toEqual([
      'retry',
      'discard',
    ]);
    expect(messageActions(msg('p', 'me', { pending: true }), you())).toEqual([]);
    expect(canDelete(msg('p', 'me', { pending: true }), you())).toBe(false);
    expect(canDelete(msg('m_1', 'me'), null)).toBe(false);
  });
});

describe('list helpers', () => {
  it('orders newest first for the inverted list without changing the input', () => {
    const list = [msg('m_1', 'a'), msg('m_2', 'a')];
    expect(newestFirst(list).map((m) => m.id)).toEqual(['m_2', 'm_1']);
    expect(list[0]?.id).toBe('m_1');
  });

  it('knows a mention of the reader', () => {
    expect(mentionsYou(msg('m_1', 'a', { mentions: ['me'] }), 'me')).toBe(true);
    expect(mentionsYou(msg('m_1', 'a'), 'me')).toBe(false);
    expect(mentionsYou(msg('m_1', 'a', { mentions: ['me'] }), null)).toBe(false);
  });

  it('says how long messages are kept', () => {
    expect(retentionLine(undefined, true).key).toBe('chat.retention.quick');
    expect(retentionLine(0, false).key).toBe('chat.retention.none');
    expect(retentionLine(7, false)).toEqual({ key: 'chat.retention.days', count: 7 });
    expect(retentionLine(undefined, false)).toEqual({ key: 'chat.retention.days', count: 30 });
  });

  it('formats the time of today and of another day', () => {
    const noon = new Date(2026, 10, 2, 12, 5).getTime();
    expect(messageTime(noon, noon + 60_000, 'en')).toMatch(/12:05/);
    expect(messageTime(noon, noon + 3 * 86_400_000, 'en')).toMatch(/Nov/);
  });
});

describe('mentions', () => {
  const members: Member[] = [
    { userId: 'me', displayName: 'Henrique', role: 'owner', canStream: true },
    { userId: 'u2', displayName: 'Ana Souza', role: 'member', canStream: true },
    { userId: 'u3', displayName: 'Mariana', role: 'member', canStream: false },
  ];

  it('lists members, then authors who left', () => {
    const people = chatPeople(members, [
      msg('m_1', 'u9', { authorName: 'Gone' }),
      msg('m_2', 'u2'),
    ]);
    expect(people.map((p) => p.name)).toEqual(['Henrique', 'Ana Souza', 'Mariana', 'Gone']);
  });

  it('suggests names that start with the query first, never the reader', () => {
    const people = chatPeople(members, []);
    expect(mentionSuggestions(people, 'ana', 'me').map((p) => p.name)).toEqual([
      'Ana Souza',
      'Mariana',
    ]);
    expect(mentionSuggestions(people, 'hen', 'me')).toEqual([]);
    expect(mentionSuggestions(people, '', 'me', 2)).toHaveLength(2);
  });

  it('replaces the typed @query with the name and puts the caret after it', () => {
    expect(insertMention('hello @an', 9, 'Ana Souza')).toEqual({
      value: 'hello @Ana Souza ',
      caret: 17,
    });
    expect(insertMention('hello', 5, 'Ana')).toBeNull();
  });

  it('turns text into text, link and mention segments', () => {
    expect(segments('hi @Ana see https://example.com/x.', [{ userId: 'u2', name: 'Ana' }])).toEqual(
      [
        { kind: 'text', text: 'hi ' },
        { kind: 'mention', text: '@Ana', userId: 'u2' },
        { kind: 'text', text: ' see ' },
        { kind: 'link', text: 'https://example.com/x', href: 'https://example.com/x' },
        { kind: 'text', text: '.' },
      ],
    );
  });

  it('never makes a link of a javascript: URL', () => {
    expect(segments('javascript:alert(1) data:text/html,x')).toEqual([
      { kind: 'text', text: 'javascript:alert(1) data:text/html,x' },
    ]);
  });
});
