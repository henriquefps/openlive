// SPDX-License-Identifier: AGPL-3.0-only
import type { PayloadOf } from '@openlive/protocol';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { newUser } from './api-helpers';
import { Client, newRoom, roomStub, seed, SPACE_ID, USERS } from './room-helpers';
import { checkLimits, roomSettingsPatch, spaceSettingsPatch } from '../src/api/settings';
import { roomSettings } from '../src/room/access';
import { CHAT_RATE_MAX, normalizeText, parseMentions } from '../src/room/chat';
import { seqOf } from '../src/room/chat-store';
import { DEV_USER_HEADER } from '../src/room/identity';
import { effectiveSettings } from '../src/room/settings';

// The text chat (docs/PROTOCOL.md 7.6): the room messages, history,
// edits and deletes with their permissions, the rate limit, unread counts, mentions, retention by
// the alarm, "no history", and erasing a deleted account's messages.

beforeAll(seed);

const WITH_TEXT = { stream: true, voice: false, camera: false, text: true };
const NO_TEXT = { stream: true, voice: false, camera: false, text: false };
const DAY_MS = 86_400_000;

const textRoom = (settings: Record<string, unknown> = {}) =>
  newRoom({ settings: { capabilities: WITH_TEXT, ...settings } });

const name = (userId: string) => `Name ${userId}`;

async function send(client: Client, text: string, clientId = crypto.randomUUID().slice(0, 8)) {
  return client.request('chat.send', { text, clientId });
}

/** Sends and returns the stored message. */
async function post(client: Client, text: string) {
  const reply = await send(client, text);
  if (reply.type !== 'chat.message') throw new Error(`expected chat.message, got ${reply.type}`);
  return reply.payload.message;
}

async function page(client: Client, payload: PayloadOf<'chat.history'> = {}) {
  const reply = await client.request('chat.history', payload);
  if (reply.type !== 'chat.page') throw new Error(`expected chat.page, got ${reply.type}`);
  return reply.payload;
}

async function rest(method: string, path: string, user: string, body?: unknown) {
  const headers: Record<string, string> = { [DEV_USER_HEADER]: user };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await exports.default.fetch(`http://localhost/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('chat rules', () => {
  it('normalizes the text: line breaks, control and bidi characters, outer space', () => {
    expect(normalizeText('  a\r\nb\rc\u0000\u0007‮d⁦  ')).toBe('a\nb\ncd');
    expect(normalizeText('\t tab\tkept \n')).toBe('tab\tkept');
  });

  it('finds mentions by display name, longest first, not inside words, never the author', () => {
    const people = [
      { userId: 'u_ana', displayName: 'Ana' },
      { userId: 'u_anam', displayName: 'Ana Maria' },
      { userId: 'u_bia', displayName: 'Bia' },
      { userId: 'u_me', displayName: 'Me' },
    ];
    expect(parseMentions('hi @ana maria and @BIA!', people, 'u_me')).toEqual(['u_anam', 'u_bia']);
    expect(parseMentions('@Ana, @Ana Maria', people, 'u_me')).toEqual(['u_anam', 'u_ana']);
    expect(parseMentions('mail x@example.com @Biazinha @me', people, 'u_me')).toEqual([]);
  });

  it('reads retention and guestsCanWrite level by level', () => {
    expect(effectiveSettings(null, '{}')).toMatchObject({
      chatRetentionDays: 30,
      guestsCanWrite: true,
    });
    // Without a room: the ceiling its rooms work within.
    expect(effectiveSettings(null, null)).toMatchObject({ chatRetentionDays: 90 });
    expect(
      effectiveSettings(
        JSON.stringify({ chatRetentionDays: 7 }),
        JSON.stringify({ chatRetentionDays: 90, guestsCanWrite: false }),
      ),
    ).toMatchObject({ chatRetentionDays: 7, guestsCanWrite: false });
    expect(effectiveSettings(null, JSON.stringify({ chatRetentionDays: 0 }))).toMatchObject({
      chatRetentionDays: 0,
    });
    // An invalid stored value is the default.
    expect(effectiveSettings(null, JSON.stringify({ chatRetentionDays: 12 }))).toMatchObject({
      chatRetentionDays: 30,
    });
    expect(roomSettingsPatch.safeParse({ chatRetentionDays: 12 }).success).toBe(false);
    expect(roomSettingsPatch.safeParse({ guestsCanWrite: false }).success).toBe(true);
    // guestsCanWrite is a room setting; the space sets the retention ceiling.
    expect(spaceSettingsPatch.safeParse({ guestsCanWrite: false }).success).toBe(false);
    expect(spaceSettingsPatch.safeParse({ chatRetentionDays: 7 }).success).toBe(true);
    const ceiling = effectiveSettings(JSON.stringify({ chatRetentionDays: 30 }), null);
    expect(() => checkLimits({ chatRetentionDays: 90 }, ceiling, '/settings')).toThrow(
      expect.objectContaining({
        code: 'setting_above_ceiling',
        params: { path: '/settings/chatRetentionDays', limit: 30 },
      }),
    );
  });
});

describe('messages', () => {
  it('sends to everyone, with the clientId only in the reply, and keeps it in history', async () => {
    const roomId = await textRoom();
    const { client: a, welcome } = await Client.join(roomId, USERS.member1.id);
    expect(welcome.chat).toEqual({ unread: 0 });
    expect(welcome.you.permissions).toMatchObject({ canReadChat: true, canWriteChat: true });
    const { client: b } = await Client.join(roomId, USERS.member2.id);
    const reply = await send(a, '  hello <b>world</b>  ', 'k1');
    expect(reply).toMatchObject({
      type: 'chat.message',
      payload: {
        clientId: 'k1',
        message: {
          userId: USERS.member1.id,
          authorName: name(USERS.member1.id),
          text: 'hello <b>world</b>',
          mentions: [],
        },
      },
    });
    const event = await b.take('chat.message');
    expect(event.id).toBeUndefined();
    expect(event.payload).toEqual({
      message: reply.type === 'chat.message' ? reply.payload.message : null,
    });
    expect((await page(b)).messages.map((m) => m.text)).toEqual(['hello <b>world</b>']);
  });

  it('pages history from the newest, oldest first, with hasMore', async () => {
    const roomId = await textRoom();
    const { client } = await Client.join(roomId, USERS.member1.id);
    const sent = [];
    for (let i = 1; i <= 5; i++) sent.push(await post(client, `m${i}`));
    const newest = await page(client, { limit: 2 });
    expect(newest.messages.map((m) => m.text)).toEqual(['m4', 'm5']);
    expect(newest.hasMore).toBe(true);
    const older = await page(client, { before: newest.messages[0]?.id ?? '', limit: 2 });
    expect(older.messages.map((m) => m.text)).toEqual(['m2', 'm3']);
    const oldest = await page(client, { before: older.messages[0]?.id ?? '', limit: 2 });
    expect(oldest).toMatchObject({ hasMore: false });
    expect(oldest.messages.map((m) => m.text)).toEqual(['m1']);
    // Ids sort with the messages.
    const seqs = sent.map((m) => seqOf(m.id) ?? 0);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
  });

  it('refuses empty, too long and rate-limited messages', async () => {
    const roomId = await textRoom();
    const { client } = await Client.join(roomId, USERS.member1.id);
    expect(await send(client, ' \n\u0000 ')).toMatchObject({
      type: 'error',
      payload: { code: 'invalid_message', path: '/payload/text' },
    });
    expect(await send(client, 'x'.repeat(2001))).toMatchObject({
      type: 'error',
      payload: { code: 'chat_message_too_long', limit: 2000 },
    });
    // 2,000 code points pass even when they are 4,000 UTF-16 units.
    expect((await send(client, '😀'.repeat(2000))).type).toBe('chat.message');
    for (let i = 1; i < CHAT_RATE_MAX; i++) await post(client, `n${i}`);
    const limited = await send(client, 'one too many');
    expect(limited).toMatchObject({ type: 'error', payload: { code: 'rate_limited' } });
    if (limited.type !== 'error') throw new Error('expected error');
    expect(limited.payload.retryAfterMs).toBeGreaterThan(0);
    expect(limited.payload.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('answers capability_disabled without text, and forbidden to a helper', async () => {
    const roomId = await newRoom({ settings: { capabilities: NO_TEXT } });
    const { client, welcome } = await Client.join(roomId, USERS.member1.id);
    expect(welcome.chat).toBeUndefined();
    expect(welcome.you.permissions).toMatchObject({ canReadChat: false, canWriteChat: false });
    for (const reply of [await send(client, 'hi'), await client.request('chat.history', {})]) {
      expect(reply).toMatchObject({
        type: 'error',
        payload: { code: 'capability_disabled', capability: 'text' },
      });
    }
    const textRoomId = await textRoom();
    const { client: helper } = await Client.join(textRoomId, USERS.member1.id, {
      client: 'helper',
      deviceId: 'd_chat',
    });
    expect(await send(helper, 'hi')).toMatchObject({
      type: 'error',
      payload: { code: 'forbidden' },
    });
  });
});

describe('edit and delete', () => {
  it('edits your own message for everyone; never someone else', async () => {
    const roomId = await textRoom();
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const { client: b } = await Client.join(roomId, USERS.member2.id);
    const message = await post(a, 'helo');
    await b.take('chat.message');
    const edited = await a.request('chat.edit', { messageId: message.id, text: 'hello' });
    expect(edited).toMatchObject({
      type: 'chat.edited',
      payload: { messageId: message.id, text: 'hello', mentions: [] },
    });
    expect((await b.take('chat.edited')).payload).toMatchObject({ text: 'hello' });
    expect((await page(b)).messages[0]).toMatchObject({
      text: 'hello',
      editedAt: expect.any(Number),
    });
    expect(await b.request('chat.edit', { messageId: message.id, text: 'mine now' })).toMatchObject(
      { type: 'error', payload: { code: 'forbidden' } },
    );
    expect(await a.request('chat.edit', { messageId: 'm_999', text: 'x' })).toMatchObject({
      type: 'error',
      payload: { code: 'chat_message_not_found', messageId: 'm_999' },
    });
  });

  it('deletes your own; owner and admin delete others under the removal rule', async () => {
    const roomId = await textRoom();
    const { client: owner } = await Client.join(roomId, USERS.owner.id);
    const { client: admin } = await Client.join(roomId, USERS.admin.id);
    const { client: member } = await Client.join(roomId, USERS.member1.id);
    const { client: other } = await Client.join(roomId, USERS.member2.id);
    const fromOwner = await post(owner, 'owner says');
    const fromAdmin = await post(admin, 'admin says');
    const fromMember = await post(member, 'member says');
    const own = await post(other, 'mine');

    const refused = { type: 'error', payload: { code: 'forbidden' } };
    // A member deletes only their own.
    expect(await other.request('chat.delete', { messageId: fromMember.id })).toMatchObject(refused);
    expect(await other.request('chat.delete', { messageId: own.id })).toMatchObject({
      type: 'chat.deleted',
      payload: { messageId: own.id },
    });
    // An admin: members' yes, the owner's no.
    expect(await admin.request('chat.delete', { messageId: fromOwner.id })).toMatchObject(refused);
    expect(await admin.request('chat.delete', { messageId: fromMember.id })).toMatchObject({
      type: 'chat.deleted',
    });
    expect(
      (await member.take('chat.deleted', (m) => m.payload.messageId === fromMember.id)).id,
    ).toBeUndefined();
    // The owner: anyone else's.
    expect(await owner.request('chat.delete', { messageId: fromAdmin.id })).toMatchObject({
      type: 'chat.deleted',
    });
    expect((await page(owner)).messages.map((m) => m.text)).toEqual(['owner says']);
    // Gone for good: no text kept, and it cannot be deleted or edited again.
    await runInDurableObject(roomStub(roomId), (_, state) => {
      const rows = state.storage.sql
        .exec<{ text: string }>('SELECT text FROM chat_messages WHERE deleted_at IS NOT NULL')
        .toArray();
      expect(rows.map((r) => r.text)).toEqual(['', '', '']);
    });
    expect(await owner.request('chat.delete', { messageId: own.id })).toMatchObject({
      type: 'error',
      payload: { code: 'chat_message_not_found' },
    });
  });
});

describe('permissions', () => {
  it('lets guests read but not write when the room says so, and follows a change', async () => {
    const roomId = await textRoom({ guestsCanWrite: false });
    const { client: member } = await Client.join(roomId, USERS.member1.id);
    const { client: guest, welcome } = await Client.join(roomId, USERS.guest1.id);
    expect(welcome.you.permissions).toMatchObject({ canReadChat: true, canWriteChat: false });
    expect(await send(guest, 'hi')).toMatchObject({
      type: 'error',
      payload: { code: 'chat_write_not_allowed' },
    });
    await post(member, 'members only');
    expect((await guest.take('chat.message')).payload.message.text).toBe('members only');
    expect((await page(guest)).messages).toHaveLength(1);

    await env.DB.prepare('UPDATE rooms SET settings_json = ? WHERE id = ?')
      .bind(JSON.stringify({ capabilities: WITH_TEXT }), roomId)
      .run();
    const settings = await roomSettings(env.DB, roomId);
    if (!settings) throw new Error('no settings');
    await roomStub(roomId).settingsChanged(settings);
    expect((await guest.take('permissions.changed')).payload.you.permissions).toMatchObject({
      canWriteChat: true,
    });
    expect((await send(guest, 'now I can')).type).toBe('chat.message');
  });

  it('removal closes the chat for the person and makes them unmentionable', async () => {
    const roomId = await textRoom();
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const { client: b } = await Client.join(roomId, USERS.member2.id);
    await roomStub(roomId).kick(USERS.member2.id, 'removed');
    expect((await b.closed).code).toBe(4004);
    const message = await post(a, `@${name(USERS.member2.id)} are you there?`);
    expect(message.mentions).toEqual([]);
  });
});

describe('unread and mentions', () => {
  it('counts unread messages by others from the last chat.read, in welcome and over REST', async () => {
    const roomId = await textRoom();
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const { client: b, welcome } = await Client.join(roomId, USERS.member2.id);
    expect(welcome.chat).toEqual({ unread: 0 });
    const first = await post(a, 'one');
    await post(a, 'two');
    await post(b, 'my own does not count');
    await post(a, 'three');
    b.close();

    const unread = await rest('GET', `/spaces/${SPACE_ID}/chat/unread`, USERS.member2.id);
    expect(unread.status).toBe(200);
    expect(unread.body.rooms[roomId]).toBe(1);

    const { client: again, welcome: back } = await Client.join(roomId, USERS.member2.id);
    // Sending marks everything up to your own message as read.
    expect(back.chat?.unread).toBe(1);
    expect(back.chat?.lastReadId).toBeDefined();
    const { messages } = await page(again);
    const last = messages.at(-1)?.id ?? '';
    expect(await again.request('chat.read', { messageId: last })).toMatchObject({ type: 'ack' });
    // Never back.
    expect(await again.request('chat.read', { messageId: first.id })).toMatchObject({
      type: 'ack',
    });
    expect(await again.request('chat.read', { messageId: 'm_99999' })).toMatchObject({
      type: 'error',
      payload: { code: 'chat_message_not_found' },
    });
    expect(await roomStub(roomId).chatUnread(USERS.member2.id)).toBe(0);
    const after = await rest('GET', `/spaces/${SPACE_ID}/chat/unread`, USERS.member2.id);
    expect(after.body.rooms[roomId]).toBeUndefined();
    // Someone outside the space learns nothing.
    expect((await rest('GET', `/spaces/${SPACE_ID}/chat/unread`, USERS.outsider.id)).status).toBe(
      404,
    );
  });

  it('resolves @name server-side and sends the mentioned user a hub notice', async () => {
    const roomId = await textRoom();
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    // Known to the room from an earlier visit, now elsewhere in the app.
    const { client: b } = await Client.join(roomId, USERS.member2.id);
    b.close();
    await a.take('member.left');
    const res = await exports.default.fetch('http://localhost/ws/hub', {
      headers: { Upgrade: 'websocket', [DEV_USER_HEADER]: USERS.member2.id },
    });
    const hub = Client.adopt(res);
    expect(
      (
        await hub.request('hello', {
          protocol: { major: 1, minor: 11 },
          client: 'web',
          clientVersion: '0.0.0',
          tabId: 't_hub',
        })
      ).type,
    ).toBe('hub.welcome');

    const message = await post(a, `hey @${name(USERS.member2.id)}, and @nobody`);
    expect(message.mentions).toEqual([USERS.member2.id]);
    expect((await hub.take('notice')).payload).toEqual({
      event: 'chat_mention',
      roomId,
      userId: USERS.member1.id,
    });
    // An edit notifies only people newly mentioned.
    const edited = await a.request('chat.edit', {
      messageId: message.id,
      text: `hey @${name(USERS.member2.id)} and @${name(USERS.admin.id)}`,
    });
    expect(edited).toMatchObject({ payload: { mentions: [USERS.member2.id] } });
    hub.close();
  });
});

describe('retention', () => {
  it('deletes expired messages from the alarm', async () => {
    const roomId = await textRoom({ chatRetentionDays: 7 });
    const { client } = await Client.join(roomId, USERS.member1.id);
    const old = await post(client, 'old');
    await post(client, 'recent');
    const stub = roomStub(roomId);
    await runInDurableObject(stub, async (_, state) => {
      // The alarm waits for the oldest message's expiry.
      expect(await state.storage.getAlarm()).toBe(old.createdAt + 7 * DAY_MS);
      state.storage.sql.exec(
        'UPDATE chat_messages SET created_at = ? WHERE seq = ?',
        Date.now() - 8 * DAY_MS,
        seqOf(old.id),
      );
      // A minute ahead, so only runDurableObjectAlarm runs it (one due now can fire on its own).
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await page(client)).messages.map((m) => m.text)).toEqual(['recent']);
  });

  it('with no history, deletes everything when the room empties', async () => {
    const roomId = await textRoom({ chatRetentionDays: 0 });
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const { client: b } = await Client.join(roomId, USERS.member2.id);
    await post(a, 'gone soon');
    a.close();
    await b.take('member.left');
    // Someone is still here: the chat stays.
    expect((await page(b)).messages).toHaveLength(1);
    b.close();
    await b.closed;
    const { client: c } = await Client.join(roomId, USERS.member1.id);
    expect((await page(c)).messages).toEqual([]);
  });

  it("deletes a room's chat when the room ends, not when it is only suspended", async () => {
    const roomId = await textRoom();
    const { client } = await Client.join(roomId, USERS.member1.id);
    await post(client, 'kept');
    await roomStub(roomId).closeRoom('suspended');
    await runInDurableObject(roomStub(roomId), (_, state) => {
      expect(state.storage.sql.exec('SELECT * FROM chat_messages').toArray()).toHaveLength(1);
    });
    await roomStub(roomId).closeRoom('archived');
    await runInDurableObject(roomStub(roomId), (_, state) => {
      expect(state.storage.sql.exec('SELECT * FROM chat_messages').toArray()).toHaveLength(0);
    });
  });
});

describe('account deletion', () => {
  it("records the rooms a user wrote in, then deletes or anonymizes the user's messages", async () => {
    const roomId = await textRoom();
    const { client: a } = await Client.join(roomId, USERS.guest2.id);
    const { client: b } = await Client.join(roomId, USERS.member1.id);
    const mine = await post(a, 'first');
    await post(a, 'second');
    const mention = await post(b, `thanks @${name(USERS.guest2.id)}`);
    expect(mention.mentions).toEqual([USERS.guest2.id]);
    const rows = await env.DB.prepare('SELECT room_id FROM chat_authors WHERE user_id = ?')
      .bind(USERS.guest2.id)
      .all<{ room_id: string }>();
    expect(rows.results.map((r) => r.room_id)).toContain(roomId);

    expect(await roomStub(roomId).eraseChatAuthor(USERS.guest2.id, 'anonymize')).toBe(2);
    const anonymized = (await page(b)).messages;
    expect(anonymized[0]).toEqual({
      id: mine.id,
      authorName: '',
      text: 'first',
      createdAt: mine.createdAt,
      mentions: [],
    });
    // The account leaves every mention.
    expect(anonymized.at(-1)?.mentions).toEqual([]);
    // Owners and admins may delete a removed account's message.
    const { client: admin } = await Client.join(roomId, USERS.admin.id);
    expect(await admin.request('chat.delete', { messageId: mine.id })).toMatchObject({
      type: 'chat.deleted',
    });

    const other = await textRoom();
    const { client: c } = await Client.join(other, USERS.guest1.id);
    const { client: d } = await Client.join(other, USERS.member2.id);
    const gone = await post(c, 'bye');
    expect(await roomStub(other).eraseChatAuthor(USERS.guest1.id, 'delete')).toBe(1);
    expect((await d.take('chat.deleted')).payload).toEqual({ messageId: gone.id });
    expect((await page(d)).messages).toEqual([]);
  });

  it('DELETE /api/admin/users/:userId applies the chosen option in every room written in', async () => {
    const admin = await newUser('chatadmin', { platformAdmin: true });
    const writer = await newUser('writer');
    await env.DB.prepare(
      "INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
    )
      .bind(SPACE_ID, writer, Date.now())
      .run();
    const rooms = [await textRoom(), await textRoom()];
    for (const roomId of rooms) {
      const { client } = await Client.join(roomId, writer);
      await post(client, `hello from ${roomId}`);
    }
    // The writer is removed from the space meanwhile: their old rooms are still erased.
    await env.DB.prepare('DELETE FROM space_members WHERE user_id = ?').bind(writer).run();
    const res = await rest('DELETE', `/admin/users/${writer}`, admin, { messages: 'anonymize' });
    expect(res.status).toBe(204);
    for (const roomId of rooms) {
      const { client } = await Client.join(roomId, USERS.member1.id);
      const { messages } = await page(client);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.userId).toBeUndefined();
      expect(messages[0]?.authorName).toBe('');
    }
    const left = await env.DB.prepare('SELECT count(*) AS n FROM chat_authors WHERE user_id = ?')
      .bind(writer)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect(
      (await rest('DELETE', `/admin/users/${USERS.guest1.id}`, admin, { messages: 'keep' })).status,
    ).toBe(400);
  });
});
