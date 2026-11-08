// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_TIMEOUT_MS,
  HubConnection,
  HubError,
  thumbnailKey,
} from '../src/hub/connection.ts';
import { CLOSE } from '../src/room/connection.ts';
import { FakeSocket } from './fake-socket.ts';
import { hubWelcome, PC } from './hub-fakes.ts';

// The web side of the user hub (PROTOCOL 8): presence, status and stats, commands matched to
// their replies by this tab's ids, picker thumbnails in memory, and the close codes.

let sockets: FakeSocket[];
const last = () => {
  const socket = sockets.at(-1);
  if (!socket) throw new Error('no socket');
  return socket;
};

function connect() {
  const hub = new HubConnection({
    url: 'ws://localhost/ws/hub',
    tabId: 't_tab',
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    random: () => 0.999_999,
  });
  hub.start();
  last().open();
  last().receive('hub.welcome', hubWelcome(), '1');
  return hub;
}

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HubConnection', () => {
  it('says hello as a web tab and lists the online helpers', () => {
    const hub = connect();
    expect(last().url).toBe('ws://localhost/ws/hub');
    expect(last().hello).toMatchObject({
      type: 'hello',
      payload: { client: 'web', tabId: 't_tab', protocol: { major: 1, minor: 22 } },
    });
    expect(hub.getState()).toMatchObject({ status: 'open', helpers: { d_pc: PC } });
  });

  it('follows presence, status and stats', () => {
    const hub = connect();
    const laptop = { ...PC, deviceId: 'd_laptop', name: 'Laptop' };
    last().receive('helper.online', { helper: laptop });
    last().receive('helper.status', {
      deviceId: 'd_pc',
      state: 'live',
      stream: { roomId: 'rm_1', streamId: 'st_1', sourceId: 'test', preset: 'game' },
    });
    const stats = {
      deviceId: 'd_pc',
      streamId: 'st_1',
      targetBitrateKbps: 12000,
      sentBitrateKbps: 11800,
      fps: 60,
      width: 1920,
      height: 1080,
      packetLossPct: 0,
      rttMs: 0,
    };
    last().receive('helper.stats', stats);
    expect(Object.keys(hub.getState().helpers)).toEqual(['d_pc', 'd_laptop']);
    expect(hub.getState().statuses['d_pc']?.state).toBe('live');
    expect(hub.getState().stats['d_pc']).toEqual(stats);

    // Back to idle: the stats go.
    last().receive('helper.status', { deviceId: 'd_pc', state: 'idle' });
    expect(hub.getState().stats).toEqual({});

    last().receive('helper.offline', { deviceId: 'd_pc' });
    expect(Object.keys(hub.getState().helpers)).toEqual(['d_laptop']);
    expect(hub.getState().statuses).toEqual({});
  });

  it('resolves a command with the reply carrying its id, and rejects an error reply', async () => {
    const hub = connect();
    const sources = hub.request('helper.listSources', { deviceId: 'd_pc', thumbnails: true });
    const start = hub.request('helper.startStream', {
      deviceId: 'd_pc',
      roomId: 'rm_1',
      sourceId: 'test',
      preset: 'game',
      audio: true,
    });
    const [list, startReq] = last().requests;
    expect(list).toMatchObject({ type: 'helper.listSources', payload: { thumbnails: true } });
    expect(startReq?.type).toBe('helper.startStream');
    // Replies in the other order: matched by id.
    last().receive('error', { code: 'quota_exhausted' }, startReq?.id);
    last().receive(
      'helper.sources',
      {
        deviceId: 'd_pc',
        sources: [{ sourceId: 'test', kind: 'screen', label: 'Test', hasAudio: true }],
      },
      list?.id,
    );
    await expect(sources).resolves.toMatchObject({ sources: [{ sourceId: 'test' }] });
    await expect(start).rejects.toEqual(new HubError({ code: 'quota_exhausted' }));
  });

  it('keeps thumbnails in memory per device and source, cleared by a new listing', () => {
    const hub = connect();
    last().receive('helper.sourceThumbnail', {
      deviceId: 'd_pc',
      sourceId: 'test',
      mimeType: 'image/jpeg',
      width: 320,
      height: 180,
      data: 'AAAA',
    });
    expect(hub.getState().thumbnails[thumbnailKey('d_pc', 'test')]).toBe(
      'data:image/jpeg;base64,AAAA',
    );
    void hub.request('helper.listSources', { deviceId: 'd_pc', thumbnails: true }).catch(() => {});
    expect(hub.getState().thumbnails).toEqual({});
  });

  it('fails commands when offline, on a drop and after the timeout', async () => {
    const hub = connect();
    const timedOut = hub.request('helper.stopStream', { deviceId: 'd_pc' });
    vi.advanceTimersByTime(COMMAND_TIMEOUT_MS);
    await expect(timedOut).rejects.toEqual(new HubError({ code: 'internal_error' }));

    const dropped = hub.request('helper.stopStream', { deviceId: 'd_pc' });
    last().serverClose(1006);
    await expect(dropped).rejects.toEqual(new HubError({ code: 'helper_offline' }));
    expect(hub.getState()).toMatchObject({ status: 'reconnecting', helpers: {} });
    await expect(hub.request('helper.stopStream', { deviceId: 'd_pc' })).rejects.toEqual(
      new HubError({ code: 'helper_offline', deviceId: 'd_pc' }),
    );

    // Reconnects with backoff.
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
  });

  it('stops for good on 4001, 4002 and 4006', () => {
    for (const [code, ended] of [
      [CLOSE.Unauthenticated, 'unauthenticated'],
      [CLOSE.Replaced, 'replaced'],
      [CLOSE.ProtocolUnsupported, 'reload'],
    ] as const) {
      const hub = connect();
      const count = sockets.length;
      last().serverClose(code);
      expect(hub.getState()).toMatchObject({ status: 'ended', ended });
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(count);
    }
  });
});
