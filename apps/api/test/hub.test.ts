// SPDX-License-Identifier: AGPL-3.0-only
import type { PayloadOf } from '@openlive/protocol';
import { PING_FRAME, PONG_FRAME } from '@openlive/protocol';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { THUMBNAIL_WINDOW_MS } from '../src/do/user-hub';
import { DEV_DEVICE_HEADER, DEV_USER_HEADER } from '../src/room/identity';
import { call, migrate } from './api-helpers';
import { Client, seed } from './room-helpers';

// The user hub (docs/PROTOCOL.md 8): presence of the user's helpers, commands relayed from a web
// tab to a helper with rewritten ids, status and stats to every tab, picker thumbnails only to the
// tab that asked, and revocation.

beforeAll(async () => {
  await migrate();
  await seed();
});

let userCounter = 0;

/** A fresh user per test, so each test gets its own UserHubDO. */
async function newHubUser(): Promise<string> {
  userCounter += 1;
  const id = `u_hub${userCounter}_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
    .bind(id, `Hub ${userCounter}`, Date.now())
    .run();
  return id;
}

/** A paired device row, as pairing creates it (name and platform come from D1). */
async function newDevice(userId: string, name = 'Desk PC'): Promise<string> {
  const id = `d_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO devices (id, user_id, name, os, arch, helper_version, token_hash, created_at)
     VALUES (?, ?, ?, 'linux', 'amd64', '0.1.0', ?, ?)`,
  )
    .bind(id, userId, name, crypto.randomUUID(), Date.now())
    .run();
  return id;
}

function upgradeHub(userId?: string, deviceId?: string): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  if (userId) headers[DEV_USER_HEADER] = userId;
  if (deviceId) headers[DEV_DEVICE_HEADER] = deviceId;
  return exports.default.fetch('http://localhost/ws/hub', { headers });
}

async function openHub(userId: string, deviceId?: string): Promise<Client> {
  const res = await upgradeHub(userId, deviceId);
  expect(res.status).toBe(101);
  return Client.adopt(res);
}

const PROTOCOL = { major: 1, minor: 22 };

async function tab(userId: string, tabId = `t_${crypto.randomUUID().slice(0, 8)}`) {
  const client = await openHub(userId);
  const reply = await client.request('hello', {
    protocol: PROTOCOL,
    client: 'web',
    clientVersion: '0.0.0',
    tabId,
  });
  expect(reply.type).toBe('hub.welcome');
  return { client, welcome: reply.payload as PayloadOf<'hub.welcome'> };
}

async function helper(userId: string, deviceId: string, clientVersion = '0.2.0') {
  const client = await openHub(userId, deviceId);
  const reply = await client.request('hello', {
    protocol: PROTOCOL,
    client: 'helper',
    clientVersion,
    deviceId,
  });
  expect(reply.type).toBe('hub.welcome');
  return { client, welcome: reply.payload as PayloadOf<'hub.welcome'> };
}

/** Sends a frame exactly as given (the helper side chooses its own reply ids). */
function sendRaw(client: Client, type: string, payload: object, id?: string): void {
  client.raw(JSON.stringify(id === undefined ? { type, payload } : { type, id, payload }));
}

/**
 * Waits until everything the hub sent `client` before now has arrived: a command always gets an
 * error (helper_offline for a tab, unknown_message_type for a helper), after any earlier message.
 */
async function sync(client: Client): Promise<void> {
  const reply = await client.request('helper.stopStream', { deviceId: 'd_sync' });
  expect(reply.type).toBe('error');
}

describe('GET /ws/hub upgrade', () => {
  it('refuses a plain GET and an anonymous caller', async () => {
    expect((await exports.default.fetch('http://localhost/ws/hub')).status).toBe(426);
    const res = await upgradeHub();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'unauthenticated' });
  });

  it('refuses a foreign Origin', async () => {
    const user = await newHubUser();
    const res = await exports.default.fetch('http://localhost/ws/hub', {
      headers: { Upgrade: 'websocket', [DEV_USER_HEADER]: user, Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'origin_not_allowed' });
  });
});

describe('handshake and presence', () => {
  it('answers ping with pong through the auto-response', async () => {
    const user = await newHubUser();
    const client = await openHub(user);
    const pong = new Promise((resolve) =>
      client.ws.addEventListener('message', (e) => resolve(e.data)),
    );
    client.raw(PING_FRAME);
    expect(await pong).toBe(PONG_FRAME);
  });

  it('requires hello first and refuses a second hello', async () => {
    const user = await newHubUser();
    const client = await openHub(user);
    expect(await client.request('helper.stopStream', { deviceId: 'd_x' })).toMatchObject({
      type: 'error',
      payload: { code: 'hello_required', messageType: 'helper.stopStream' },
    });
    const { client: t } = await tab(user);
    expect(
      await t.request('hello', { protocol: PROTOCOL, client: 'web', clientVersion: '0.0.0' }),
    ).toMatchObject({ type: 'error', payload: { code: 'invalid_message', path: '/type' } });
  });

  it('closes 4006 on an unsupported major version', async () => {
    const user = await newHubUser();
    const client = await openHub(user);
    const reply = await client.request('hello', {
      protocol: { major: 2, minor: 0 },
      client: 'web',
      clientVersion: '0.0.0',
    });
    expect(reply).toMatchObject({ type: 'error', payload: { code: 'protocol_unsupported' } });
    expect((await client.closed).code).toBe(4006);
  });

  it('welcomes a tab with the online helpers and tells it when one comes and goes', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user, 'Henrique PC');
    const { client: t1, welcome } = await tab(user);
    // The version is the one the helper runs (its hello), not the one recorded at pairing.
    expect(welcome).toMatchObject({ protocol: PROTOCOL, userId: user, helpers: [] });
    expect(welcome.connectionId).toMatch(/^c_/);

    const { client: h } = await helper(user, deviceId);
    const online = await t1.take('helper.online');
    expect(online.payload.helper).toEqual({
      deviceId,
      name: 'Henrique PC',
      os: 'linux',
      arch: 'amd64',
      helperVersion: '0.2.0',
      protocol: PROTOCOL,
    });

    const { welcome: w2 } = await tab(user);
    expect(w2.helpers).toEqual([online.payload.helper]);

    h.close();
    expect((await t1.take('helper.offline')).payload).toEqual({ deviceId });
  });

  it('refuses a helper hello that names another device, or from a browser session', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user);
    const c1 = await openHub(user, deviceId);
    expect(
      await c1.request('hello', {
        protocol: PROTOCOL,
        client: 'helper',
        clientVersion: '0.1.0',
        deviceId: 'd_other',
      }),
    ).toMatchObject({ type: 'error', payload: { code: 'unauthenticated' } });
    expect((await c1.closed).code).toBe(4001);

    const c2 = await openHub(user);
    expect(
      await c2.request('hello', {
        protocol: PROTOCOL,
        client: 'helper',
        clientVersion: '0.1.0',
        deviceId,
      }),
    ).toMatchObject({ type: 'error', payload: { code: 'unauthenticated' } });
    expect((await c2.closed).code).toBe(4001);
  });

  it('replaces an older socket of the same helper (4002) without going offline', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user);
    const { client: t } = await tab(user);
    const { client: h1 } = await helper(user, deviceId);
    await t.take('helper.online');
    await helper(user, deviceId);
    expect((await h1.closed).code).toBe(4002);
    await t.take('helper.online');
    await sync(t);
    expect(t.drainAll('helper.offline')).toEqual([]);
  });

  it("one user's hub never sees another user's helpers", async () => {
    const alice = await newHubUser();
    const bob = await newHubUser();
    const { client: aliceTab } = await tab(alice);
    await helper(bob, await newDevice(bob));
    await sync(aliceTab);
    expect(aliceTab.drainAll('helper.online')).toEqual([]);
  });
});

describe('commands', () => {
  it('relays a command with a hub id and the reply back with the tab id', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user);
    const { client: t } = await tab(user);
    const { client: h } = await helper(user, deviceId);

    const tabId = t.send('helper.startStream', {
      deviceId,
      roomId: 'r_1',
      sourceId: 'test',
      preset: 'game',
      audio: true,
    });
    const cmd = await h.take('helper.startStream');
    expect(cmd.payload).toEqual({
      deviceId,
      roomId: 'r_1',
      sourceId: 'test',
      preset: 'game',
      audio: true,
    });
    // The helper sees the hub's id, never the tab's.
    expect(cmd.id).toMatch(/^h_/);
    expect(cmd.id).not.toBe(tabId);

    sendRaw(h, 'ack', {}, cmd.id);
    const reply = await t.takeWhere((m) => m.id === tabId);
    expect(reply).toEqual({ type: 'ack', id: tabId, payload: {} });
  });

  it('relays helper.setVoiceOutput to the helper (since 1.16)', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user);
    const { client: t } = await tab(user);
    const { client: h } = await helper(user, deviceId);

    const tabId = t.send('helper.setVoiceOutput', { deviceId, label: 'USB Speakers' });
    const cmd = await h.take('helper.setVoiceOutput');
    expect(cmd.payload).toEqual({ deviceId, label: 'USB Speakers' });
    sendRaw(h, 'ack', {}, cmd.id);
    expect(await t.takeWhere((m) => m.id === tabId)).toEqual({
      type: 'ack',
      id: tabId,
      payload: {},
    });
  });

  it('relays an error reply, and only to the tab that asked', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user);
    const { client: asking } = await tab(user);
    const { client: other } = await tab(user);
    const { client: h } = await helper(user, deviceId);

    const tabId = asking.send('helper.setPreset', { deviceId, preset: 'max' });
    const cmd = await h.take('helper.setPreset');
    sendRaw(h, 'error', { code: 'preset_not_allowed', preset: 'max' }, cmd.id);
    expect(await asking.takeWhere((m) => m.id === tabId)).toEqual({
      type: 'error',
      id: tabId,
      payload: { code: 'preset_not_allowed', preset: 'max' },
    });
    await sync(other);
    expect(other.drainAll('error')).toEqual([]);
  });

  it('answers helper_offline for a helper that is not connected', async () => {
    const user = await newHubUser();
    const { client: t } = await tab(user);
    expect(await t.request('helper.pauseStream', { deviceId: 'd_gone', paused: true })).toEqual(
      expect.objectContaining({
        type: 'error',
        payload: { code: 'helper_offline', deviceId: 'd_gone' },
      }),
    );
  });

  it('fails pending commands with helper_offline when the helper disconnects', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user);
    const { client: t } = await tab(user);
    const { client: h } = await helper(user, deviceId);
    const tabId = t.send('helper.stopStream', { deviceId });
    await h.take('helper.stopStream');
    h.close();
    expect(await t.takeWhere((m) => m.id === tabId)).toMatchObject({
      type: 'error',
      payload: { code: 'helper_offline', deviceId },
    });
  });

  it('drops a reply whose id the hub never issued, or that comes from another socket', async () => {
    const user = await newHubUser();
    const d1 = await newDevice(user);
    const d2 = await newDevice(user);
    const { client: t } = await tab(user);
    const { client: h1 } = await helper(user, d1);
    const { client: h2 } = await helper(user, d2);
    const tabId = t.send('helper.stopStream', { deviceId: d1 });
    const cmd = await h1.take('helper.stopStream');
    sendRaw(h2, 'ack', {}, cmd.id);
    sendRaw(h1, 'ack', {}, 'h_made_up');
    await sync(t);
    expect(t.drainAll('ack')).toEqual([]);
    sendRaw(h1, 'ack', {}, cmd.id);
    expect(await t.takeWhere((m) => m.id === tabId)).toMatchObject({ type: 'ack' });
  });

  it('refuses commands from a helper and reports from a tab', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user);
    const { client: t } = await tab(user);
    const { client: h } = await helper(user, deviceId);
    expect(await h.request('helper.stopStream', { deviceId })).toMatchObject({
      type: 'error',
      payload: { code: 'unknown_message_type', messageType: 'helper.stopStream' },
    });
    expect(await t.request('helper.status', { deviceId, state: 'idle' })).toMatchObject({
      type: 'error',
      payload: { code: 'unknown_message_type', messageType: 'helper.status' },
    });
    expect(
      await t.request('helper.voiceShortcut', { deviceId, action: 'toggleMute', pressed: true }),
    ).toMatchObject({
      type: 'error',
      payload: { code: 'unknown_message_type', messageType: 'helper.voiceShortcut' },
    });
  });
});

describe('reports', () => {
  it('relays status and stats to every tab with the helper own deviceId', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user);
    const { client: t1 } = await tab(user);
    const { client: t2 } = await tab(user);
    const { client: h } = await helper(user, deviceId);
    sendRaw(h, 'helper.status', {
      deviceId: 'd_spoofed',
      state: 'live',
      stream: { roomId: 'r_1', streamId: 'st_1', sourceId: 'test', preset: 'game' },
    });
    for (const t of [t1, t2]) {
      expect((await t.take('helper.status')).payload).toEqual({
        deviceId,
        state: 'live',
        stream: { roomId: 'r_1', streamId: 'st_1', sourceId: 'test', preset: 'game' },
      });
    }
    const stats = {
      deviceId,
      streamId: 'st_1',
      targetBitrateKbps: 8000,
      sentBitrateKbps: 7900,
      fps: 60,
      width: 1920,
      height: 1080,
      packetLossPct: 0,
      rttMs: 0,
      encoder: 'x264',
    };
    sendRaw(h, 'helper.stats', stats);
    expect((await t2.take('helper.stats')).payload).toEqual(stats);
  });

  it('relays a global voice shortcut to every tab with the helper own deviceId (8.5)', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user);
    const { client: t1 } = await tab(user);
    const { client: t2 } = await tab(user);
    const { client: h } = await helper(user, deviceId);
    sendRaw(h, 'helper.voiceShortcut', {
      deviceId: 'd_spoofed',
      action: 'pushToTalk',
      pressed: true,
    });
    sendRaw(h, 'helper.voiceShortcut', { deviceId, action: 'pushToTalk', pressed: false });
    for (const t of [t1, t2]) {
      expect((await t.take('helper.voiceShortcut')).payload).toEqual({
        deviceId,
        action: 'pushToTalk',
        pressed: true,
      });
      expect((await t.take('helper.voiceShortcut')).payload).toEqual({
        deviceId,
        action: 'pushToTalk',
        pressed: false,
      });
    }
  });

  it('gives a tab that connects later the last status of each online helper', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user);
    const { client: h } = await helper(user, deviceId);
    sendRaw(h, 'helper.status', { deviceId, state: 'paused' });
    await sync(h);
    const { client: late } = await tab(user);
    expect((await late.take('helper.status')).payload).toEqual({ deviceId, state: 'paused' });

    // Offline: the status is forgotten.
    h.close();
    await late.take('helper.offline');
    const { client: later } = await tab(user);
    await sync(later);
    expect(later.drainAll('helper.status')).toEqual([]);
  });
});

describe('source picker thumbnails', () => {
  const thumb = (deviceId: string, sourceId = 'test') => ({
    deviceId,
    sourceId,
    mimeType: 'image/jpeg',
    width: 320,
    height: 180,
    data: 'AAAA',
  });

  it('go only to the tab that listed the sources, and are never stored', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user);
    const { client: asking } = await tab(user);
    const { client: other } = await tab(user);
    const { client: h } = await helper(user, deviceId);

    // Before any listSources a thumbnail goes nowhere.
    sendRaw(h, 'helper.sourceThumbnail', thumb(deviceId));
    await sync(asking);
    expect(asking.drainAll('helper.sourceThumbnail')).toEqual([]);

    const tabId = asking.send('helper.listSources', { deviceId, thumbnails: true });
    const cmd = await h.take('helper.listSources');
    const sources = [{ sourceId: 'test', kind: 'screen', label: 'Test pattern', hasAudio: true }];
    sendRaw(h, 'helper.sources', { deviceId, sources }, cmd.id);
    expect(await asking.takeWhere((m) => m.id === tabId)).toEqual({
      type: 'helper.sources',
      id: tabId,
      payload: { deviceId, sources },
    });
    sendRaw(h, 'helper.sourceThumbnail', thumb(deviceId));
    expect((await asking.take('helper.sourceThumbnail')).payload).toEqual(thumb(deviceId));
    await sync(other);
    expect(other.drainAll('helper.sourceThumbnail')).toEqual([]);

    // Nothing of the image is in the DO's storage.
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(user));
    await runInDurableObject(stub, (_instance, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((r) => r.name)
        .filter((n) => !n.startsWith('_cf') && !n.startsWith('sqlite'));
      for (const table of tables) {
        const rows = JSON.stringify(state.storage.sql.exec(`SELECT * FROM ${table}`).toArray());
        expect(rows).not.toContain('AAAA');
      }
    });
  });

  it('stop after the window, and do not go to a tab that asked without thumbnails', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user);
    const { client: t } = await tab(user);
    const { client: h } = await helper(user, deviceId);

    t.send('helper.listSources', { deviceId, thumbnails: false });
    const plain = await h.take('helper.listSources');
    sendRaw(h, 'helper.sources', { deviceId, sources: [] }, plain.id);
    await t.take('helper.sources');
    sendRaw(h, 'helper.sourceThumbnail', thumb(deviceId));
    await sync(t);
    expect(t.drainAll('helper.sourceThumbnail')).toEqual([]);

    t.send('helper.listSources', { deviceId, thumbnails: true });
    const withThumbs = await h.take('helper.listSources');
    sendRaw(h, 'helper.sources', { deviceId, sources: [] }, withThumbs.id);
    await t.take('helper.sources');
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(user));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE thumbnail_targets SET expires_at = ?',
        Date.now() - THUMBNAIL_WINDOW_MS,
      );
    });
    sendRaw(h, 'helper.sourceThumbnail', thumb(deviceId));
    await sync(t);
    expect(t.drainAll('helper.sourceThumbnail')).toEqual([]);
  });
});

describe('revocation', () => {
  it('closes the helper socket with 4001 and the tabs see it go offline', async () => {
    const user = await newHubUser();
    const deviceId = await newDevice(user);
    const { client: t } = await tab(user);
    const { client: h } = await helper(user, deviceId);
    await t.take('helper.online');
    expect((await call('DELETE', `/me/devices/${deviceId}`, user)).status).toBe(204);
    expect((await h.take('error')).payload).toEqual({ code: 'session_expired' });
    expect((await h.closed).code).toBe(4001);
    expect((await t.take('helper.offline')).payload).toEqual({ deviceId });
  });
});
