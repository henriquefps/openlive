// SPDX-License-Identifier: AGPL-3.0-only
import type { WelcomePayload } from '@openlive/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomConnection } from '../src/room/connection.ts';
import type { VoiceParticipant } from '../src/voice/contract.ts';
import { FakeSocket } from './fake-socket.ts';

// The voice part of the room socket (docs/PROTOCOL.md 7.5): voice.join and its answer by id, the
// roster, voice.tracks, being taken out, and joining again after a reconnect.

const inVoice = (userId: string, patch: Partial<VoiceParticipant> = {}): VoiceParticipant => ({
  userId,
  muted: false,
  deafened: false,
  serverMuted: false,
  joinedAt: 1,
  ...patch,
});

function welcome(extra: Record<string, unknown> = {}): WelcomePayload {
  return {
    protocol: { major: 1, minor: 20 },
    minProtocol: { major: 1, minor: 0 },
    serverTime: Date.now(),
    you: {
      userId: 'u_ana',
      connectionId: 'c_1',
      role: 'guest',
      permissions: { canStream: false, canModerate: false, canSpeak: false },
    },
    room: { roomId: 'rm_1', spaceId: 'sp_1', kind: 'fixed', visibility: 'space', name: 'Room' },
    settings: {
      maxStreams: 4,
      maxViewersPerStream: 6,
      maxBitrateKbps: 8000,
      allowedPresets: [],
      capabilities: { stream: true, voice: true, camera: false, text: false },
    },
    members: [],
    streams: [],
    ...extra,
  } as WelcomePayload;
}

let sockets: FakeSocket[];
const last = () => sockets.at(-1) as FakeSocket;

function connect() {
  const connection = new RoomConnection({
    url: 'ws://localhost/ws/rooms/rm_1',
    tabId: 't_tab',
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    random: () => 0.999_999,
  });
  connection.start();
  last().open();
  last().receive('welcome', welcome({ voice: [inVoice('u_bia')] }));
  return connection;
}

const voiceRequests = () => last().requests.filter((r) => r.type.startsWith('voice.'));

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('RoomConnection: voice', () => {
  it('takes the roster and canSpeak from welcome', () => {
    const c = connect();
    expect(c.getState().voice).toMatchObject({
      self: 'out',
      selfId: 'u_ana',
      canSpeak: false,
      participants: [inVoice('u_bia')],
    });
  });

  it('joins with mute and deafen; the voice.joined with the request id puts this tab in', () => {
    const c = connect();
    c.joinVoice({ muted: true, deafened: false });
    const [join] = voiceRequests();
    expect(join).toMatchObject({ type: 'voice.join', payload: { muted: true, deafened: false } });
    expect(c.getState().voice.self).toBe('joining');
    // The same user joining from another tab (no id) does not count.
    last().receive('voice.joined', { participant: inVoice('u_ana') });
    expect(c.getState().voice.self).toBe('joining');
    last().receive('voice.joined', { participant: inVoice('u_ana', { muted: true }) }, join?.id);
    expect(c.getState().voice.self).toBe('in');
    last().receive('voice.tracks', { tracks: [{ trackId: 'tr_1', userId: 'u_bia' }] });
    expect(c.getState().voice.tracks).toEqual([{ trackId: 'tr_1', userId: 'u_bia' }]);
  });

  it('a refused join (voice full) is out with the code', () => {
    const c = connect();
    c.joinVoice();
    const [join] = voiceRequests();
    last().receive('error', { code: 'voice_full', limit: 12 }, join?.id);
    expect(c.getState().voice).toMatchObject({
      self: 'out',
      error: { code: 'voice_full', limit: 12 },
    });
  });

  it('state, server mute and kick go out as voice messages', () => {
    const c = connect();
    c.joinVoice();
    last().receive('voice.joined', { participant: inVoice('u_ana') }, voiceRequests()[0]?.id);
    c.setVoiceState({ muted: true, deafened: true });
    c.serverMute('u_bia', true);
    c.kickFromVoice('u_bia');
    expect(voiceRequests().slice(1)).toEqual([
      { type: 'voice.state', payload: { muted: true, deafened: true } },
      { type: 'voice.serverMute', payload: { userId: 'u_bia', muted: true } },
      { type: 'voice.kick', payload: { userId: 'u_bia' } },
    ]);
  });

  it('updates and leaves of others change the roster; moved keeps them in it', () => {
    const c = connect();
    last().receive('voice.updated', { participant: inVoice('u_bia', { deafened: true }) });
    expect(c.getState().voice.participants[0]?.deafened).toBe(true);
    last().receive('voice.left', { userId: 'u_bia', reason: 'left' });
    expect(c.getState().voice.participants).toEqual([]);
  });

  it('taken out (kicked, moved): out with the reason, and not joined again', () => {
    const c = connect();
    c.joinVoice();
    last().receive('voice.joined', { participant: inVoice('u_ana') }, voiceRequests()[0]?.id);
    last().receive('voice.left', { userId: 'u_ana', reason: 'moved' });
    expect(c.getState().voice).toMatchObject({ self: 'out', left: 'moved' });
    last().serverClose(1006);
    vi.advanceTimersByTime(1_000);
    last().open();
    last().receive('welcome', welcome());
    expect(voiceRequests()).toEqual([]);
  });

  it('a reconnect joins voice again', () => {
    const c = connect();
    c.joinVoice();
    last().receive('voice.joined', { participant: inVoice('u_ana') }, voiceRequests()[0]?.id);
    last().serverClose(1006);
    expect(c.getState().voice).toMatchObject({ self: 'joining', left: 'disconnected' });
    vi.advanceTimersByTime(1_000);
    last().open();
    last().receive('welcome', welcome());
    expect(voiceRequests().map((r) => r.type)).toEqual(['voice.join']);
    last().receive('voice.joined', { participant: inVoice('u_ana') }, voiceRequests()[0]?.id);
    expect(c.getState().voice.self).toBe('in');
  });

  it('leaving sends voice.leave; a late voice.joined does not put the tab back in', () => {
    const c = connect();
    c.joinVoice();
    const id = voiceRequests()[0]?.id;
    c.leaveVoice();
    expect(c.getState().voice.self).toBe('out');
    last().receive('voice.joined', { participant: inVoice('u_ana') }, id);
    expect(c.getState().voice.self).toBe('out');
    expect(voiceRequests().map((r) => r.type)).toEqual(['voice.join', 'voice.leave']);
  });

  it('voice turned off in the room: out, roster cleared', () => {
    const c = connect();
    c.joinVoice();
    last().receive('voice.joined', { participant: inVoice('u_ana') }, voiceRequests()[0]?.id);
    const settings = welcome().settings;
    last().receive('room.updated', {
      settings: { ...settings, capabilities: { ...settings.capabilities, voice: false } },
    });
    expect(c.getState().voice).toMatchObject({
      self: 'out',
      participants: [],
      left: 'capability_disabled',
    });
  });
});

describe('RoomConnection: cameras (PROTOCOL 7.7)', () => {
  it('takes canUseCamera from welcome and permissions.changed', () => {
    const c = connect();
    expect(c.getState().voice.canUseCamera).toBe(false);
    last().receive('permissions.changed', {
      you: {
        userId: 'u_ana',
        connectionId: 'c_1',
        role: 'member',
        permissions: { canStream: true, canModerate: false, canUseCamera: true },
      },
    });
    expect(c.getState().voice.canUseCamera).toBe(true);
  });

  it('keeps the cameras of voice.tracks while in voice, and drops them on leaving', () => {
    const c = connect();
    c.joinVoice();
    last().receive('voice.joined', { participant: inVoice('u_ana') }, voiceRequests()[0]?.id);
    const cameras = [{ trackId: 'ct_1', userId: 'u_bia', rids: ['h', 'l'] }];
    last().receive('voice.tracks', { tracks: [], cameras });
    expect(c.getState().voice.cameras).toEqual(cameras);
    // A server before 1.12 sends no cameras.
    last().receive('voice.tracks', { tracks: [] });
    expect(c.getState().voice.cameras).toEqual([]);
    last().receive('voice.tracks', { tracks: [], cameras });
    c.leaveVoice();
    expect(c.getState().voice.cameras).toEqual([]);
  });

  it('numbers voice.cameraStopped so the same reason twice is seen twice', () => {
    const c = connect();
    last().receive('voice.cameraStopped', { reason: 'moderator' });
    expect(c.getState().voice.cameraStopped).toEqual({ reason: 'moderator', seq: 1 });
    last().receive('voice.cameraStopped', { reason: 'moderator' });
    expect(c.getState().voice.cameraStopped).toEqual({ reason: 'moderator', seq: 2 });
  });

  it("sends voice.cameraOff for a moderator's click", () => {
    const c = connect();
    c.cameraOff('u_bia');
    expect(voiceRequests()).toEqual([{ type: 'voice.cameraOff', payload: { userId: 'u_bia' } }]);
  });
});
