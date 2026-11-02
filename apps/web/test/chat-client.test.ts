// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { mentionQuery, segments } from '../src/chat/text.ts';
import { chatSettings, message, SELF, setupChat, welcome, you } from './chat-fakes.ts';

// The chat client (chat/client.ts) over a fake room socket, and the text segmentation that keeps
// rendering safe (chat/text.ts).

describe('ChatClient', () => {
  it('loads the newest page after the welcome, with the unread count', () => {
    const { socket, client } = setupChat([message(1), message(2)], {
      chat: { unread: 2, lastReadId: 'm_0' },
    });
    expect(socket.sent[0]).toMatchObject({ type: 'chat.history', payload: { limit: 50 } });
    expect(client.getState()).toMatchObject({ status: 'ready', unread: 2, lastReadId: 'm_0' });
    expect(client.getState().messages.map((m) => m.id)).toEqual(['m_1', 'm_2']);
  });

  it('stays off in a room without text, and turns off when text goes away', () => {
    const off = setupChat([], {
      settings: chatSettings({
        capabilities: { stream: true, voice: false, camera: false, text: false },
      }),
    });
    expect(off.socket.sent).toEqual([]);
    expect(off.client.getState().status).toBe('off');

    const { socket, client } = setupChat([message(1)]);
    socket.receive('room.updated', {
      settings: chatSettings({
        capabilities: { stream: true, voice: false, camera: false, text: false },
      }),
    });
    expect(client.getState()).toMatchObject({ status: 'off', messages: [] });
  });

  it('sends with an optimistic copy and swaps in the confirmed message', () => {
    const { socket, client } = setupChat([message(1)]);
    client.send('  hello  ');
    expect(client.getState().messages.at(-1)).toMatchObject({
      text: 'hello',
      pending: true,
      clientId: 'k1',
      userId: SELF,
      authorName: 'Ana',
    });
    const sent = socket.last('chat.send');
    expect(sent.payload).toEqual({ text: 'hello', clientId: 'k1' });
    socket.receive(
      'chat.message',
      { message: message(2, { userId: SELF, authorName: 'Ana', text: 'hello' }), clientId: 'k1' },
      sent.id,
    );
    const messages = client.getState().messages;
    expect(messages.map((m) => m.id)).toEqual(['m_1', 'm_2']);
    expect(messages[1]?.pending).toBeUndefined();
    expect(client.getState().lastReadId).toBe('m_2');
  });

  it('marks a refused send as failed; retry sends it again, discard drops it', () => {
    const { socket, client } = setupChat();
    client.send('x'.repeat(10));
    socket.receive(
      'error',
      { code: 'rate_limited', retryAfterMs: 2_000 },
      socket.last('chat.send').id,
    );
    expect(client.getState().messages[0]).toMatchObject({
      failed: { code: 'rate_limited' },
    });
    expect(client.getState().messages[0]?.pending).toBeUndefined();
    client.retry('k1');
    expect(client.getState().messages[0]).toMatchObject({ pending: true });
    expect(client.getState().messages[0]?.failed).toBeUndefined();
    expect(socket.sent.filter((s) => s.type === 'chat.send')).toHaveLength(2);
    socket.receive('error', { code: 'internal_error' }, socket.last('chat.send').id);
    client.discard('k1');
    expect(client.getState().messages).toEqual([]);
  });

  it('counts messages by others while out of sight, then marks them read in view', () => {
    const { socket, client } = setupChat([message(1)]);
    socket.receive('chat.message', { message: message(2) });
    socket.receive('chat.message', { message: message(3) });
    // A duplicate (a late page) is not counted twice.
    socket.receive('chat.message', { message: message(3) });
    expect(client.getState().unread).toBe(2);
    expect(socket.sent.some((s) => s.type === 'chat.read')).toBe(false);
    client.setActive(true);
    expect(socket.last('chat.read').payload).toEqual({ messageId: 'm_3' });
    expect(client.getState()).toMatchObject({ unread: 0, lastReadId: 'm_3' });
    // In view, new messages are read at once.
    socket.receive('chat.message', { message: message(4) });
    expect(socket.last('chat.read').payload).toEqual({ messageId: 'm_4' });
    expect(client.getState().unread).toBe(0);
  });

  it('calls onMention for a mention while out of sight', () => {
    const onMention = vi.fn();
    const { socket } = setupChat([], { onMention });
    socket.receive('chat.message', { message: message(1, { mentions: ['u_cai'] }) });
    socket.receive('chat.message', { message: message(2, { mentions: [SELF] }) });
    expect(onMention).toHaveBeenCalledTimes(1);
    expect(onMention.mock.calls[0]?.[0]).toMatchObject({ id: 'm_2' });
  });

  it('applies edits and deletes from anyone; reports a refused edit', () => {
    const { socket, client } = setupChat([message(1), message(2, { userId: SELF })]);
    socket.receive('chat.edited', {
      messageId: 'm_1',
      text: 'fixed',
      editedAt: 5,
      mentions: [],
    });
    expect(client.getState().messages[0]).toMatchObject({ text: 'fixed', editedAt: 5 });
    socket.receive('chat.deleted', { messageId: 'm_1' });
    expect(client.getState().messages.map((m) => m.id)).toEqual(['m_2']);

    client.edit('m_2', ' new ');
    expect(socket.last('chat.edit').payload).toEqual({ messageId: 'm_2', text: 'new' });
    socket.receive('error', { code: 'forbidden' }, socket.last('chat.edit').id);
    expect(client.getState().error).toEqual({ code: 'forbidden' });
    client.delete('m_2');
    expect(socket.last('chat.delete').payload).toEqual({ messageId: 'm_2' });
  });

  it('loads older pages before the oldest message, once at a time', () => {
    const first = Array.from({ length: 50 }, (_, i) => message(i + 51));
    const { socket, client } = setupChat(first);
    expect(client.getState().hasMore).toBe(true);
    client.loadOlder();
    client.loadOlder();
    const older = socket.sent.filter((s) => s.type === 'chat.history');
    expect(older).toHaveLength(2);
    expect(older[1]?.payload).toEqual({ before: 'm_51', limit: 50 });
    socket.receive(
      'chat.page',
      { messages: [message(49), message(50)], hasMore: false },
      older[1]?.id,
    );
    const state = client.getState();
    expect(state.messages[0]?.id).toBe('m_49');
    expect(state).toMatchObject({ hasMore: false, loadingOlder: false });
    expect(state.messages).toHaveLength(52);
  });

  it('after a reconnect, reloads the newest page and keeps unsent messages as failed', () => {
    const { socket, client } = setupChat([message(1)]);
    client.send('lost in the reconnect');
    welcome(socket, { you: you() });
    expect(client.getState().messages[0]).toMatchObject({
      text: 'lost in the reconnect',
      failed: { code: 'internal_error' },
    });
    socket.receive(
      'chat.page',
      { messages: [message(1), message(2)], hasMore: false },
      socket.last('chat.history').id,
    );
    expect(client.getState().messages.map((m) => m.id)).toEqual(['m_1', 'm_2', 'pending_k1']);
  });
});

describe('chat text', () => {
  it('keeps markup as text: only http(s) URLs become links', () => {
    const text =
      '<img src=x onerror=alert(1)> javascript:alert(1) data:text/html,x https://ok.example/a?b=1';
    expect(segments(text)).toEqual([
      { kind: 'text', text: '<img src=x onerror=alert(1)> javascript:alert(1) data:text/html,x ' },
      { kind: 'link', text: 'https://ok.example/a?b=1', href: 'https://ok.example/a?b=1' },
    ]);
  });

  it('leaves sentence punctuation out of a link but keeps balanced parentheses', () => {
    expect(segments('see https://a.example/x.')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'https://a.example/x', href: 'https://a.example/x' },
      { kind: 'text', text: '.' },
    ]);
    expect(segments('(https://en.wikipedia.org/wiki/Foo_(bar))')[1]).toMatchObject({
      href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
    });
  });

  it('highlights the mentions the room resolved, by name, longest first', () => {
    expect(
      segments('hi @ana maria and @Bia, not @Biazinha', [
        { userId: 'u_am', name: 'Ana Maria' },
        { userId: 'u_bia', name: 'Bia' },
      ]),
    ).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', text: '@ana maria', userId: 'u_am' },
      { kind: 'text', text: ' and ' },
      { kind: 'mention', text: '@Bia', userId: 'u_bia' },
      { kind: 'text', text: ', not @Biazinha' },
    ]);
  });

  it('finds the @query before the caret for the autocomplete', () => {
    expect(mentionQuery('hi @an', 6)).toEqual({ start: 3, query: 'an' });
    expect(mentionQuery('hi @Ana Ma', 10)).toEqual({ start: 3, query: 'Ana Ma' });
    expect(mentionQuery('mail a@b', 8)).toBeNull();
    expect(mentionQuery('@a\nb', 4)).toBeNull();
    expect(mentionQuery('no at', 5)).toBeNull();
  });
});
