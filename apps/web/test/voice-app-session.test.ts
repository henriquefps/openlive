// SPDX-License-Identifier: AGPL-3.0-only
import type { RoomCapabilities, WelcomePayload } from '@openlive/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomConnection } from '../src/room/connection.ts';
import { roomSocketApi } from '../src/room/socket-api.ts';
import { CameraClient, DEFAULT_CAMERA_PREFS } from '../src/voice/camera.ts';
import { VoiceClient } from '../src/voice/client.ts';
import { DEFAULT_PREFS } from '../src/voice/prefs.ts';
import { RoomSession, type SessionRtc, VoiceSessions } from '../src/voice/session.ts';
import { fakeCameraDevices, fakeCameraMedia } from './camera-fakes.ts';
import { FakeSocket } from './fake-socket.ts';
import { fakeDevices, fakeMedia, fakeOutput } from './voice-fakes.ts';

// The app's voice session (voice/session.ts) against real room connections and voice clients on
// fake sockets and devices: joining, leaving the room page and coming back, switching rooms,
// disconnecting from the panel, and the room ending the voice (kick, voice turned off).

const VOICE_TEXT: RoomCapabilities = { stream: false, voice: true, camera: true, text: true };

function welcome(roomId: string, capabilities: RoomCapabilities = VOICE_TEXT): WelcomePayload {
  return {
    protocol: { major: 1, minor: 12 },
    minProtocol: { major: 1, minor: 0 },
    serverTime: Date.now(),
    you: {
      userId: 'u_ana',
      connectionId: `c_${roomId}`,
      role: 'member',
      permissions: { canStream: false, canModerate: false, canUseCamera: true },
    },
    room: {
      roomId,
      spaceId: 'sp_1',
      kind: 'fixed',
      visibility: 'space',
      name: roomId === 'rm_a' ? 'Hangout' : 'Games',
    },
    settings: {
      maxStreams: 4,
      maxViewersPerStream: 6,
      maxBitrateKbps: 8000,
      allowedPresets: [],
      capabilities,
    },
    members: [],
    streams: [],
  } as WelcomePayload;
}

function fakeRtc(): SessionRtc & { started: number; closed: number } {
  return {
    started: 0,
    closed: 0,
    getStatus: () => 'idle',
    subscribe: () => () => undefined,
    start() {
      this.started += 1;
    },
    close() {
      this.closed += 1;
    },
    getStats: () => Promise.resolve({ forEach: () => undefined }),
  };
}

/** Sessions whose rooms connect on FakeSockets; `socket(roomId)` is the room's latest. */
function setup() {
  const sockets: FakeSocket[] = [];
  const created: string[] = [];
  const sessions = new VoiceSessions((roomId) => {
    created.push(roomId);
    const connection = new RoomConnection({
      url: `ws://localhost/ws/rooms/${roomId}`,
      tabId: 't_tab',
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      random: () => 0.5,
    });
    const socket = roomSocketApi(connection);
    const voice = new VoiceClient({
      signal: socket.voice,
      media: fakeMedia().media,
      devices: fakeDevices().devices,
      output: fakeOutput().output,
      createMonitor: () => ({ add: () => undefined, remove: () => undefined, dispose: () => {} }),
      keys: null,
      prefs: DEFAULT_PREFS,
      savePrefs: () => undefined,
      loadVolume: () => 1,
      saveVolume: () => undefined,
    });
    const camera = new CameraClient({
      signal: socket.voice,
      media: fakeCameraMedia().media,
      devices: fakeCameraDevices().devices,
      prefs: DEFAULT_CAMERA_PREFS,
      savePrefs: () => undefined,
    });
    return new RoomSession({
      roomId,
      parts: { connection, rtc: fakeRtc(), voice, camera, signal: socket.voice, socket },
      fake: false,
      window: null,
      createMeter: () => ({ sample: () => ({ lossPct: 0, rttMs: null }), update: () => 'good' }),
    });
  });
  const socket = (roomId: string) => {
    const found = sockets.filter((s) => s.url.endsWith(roomId)).at(-1);
    if (!found) throw new Error(`no socket for ${roomId}`);
    return found;
  };
  /** The page shows the room: held, and welcomed on its socket. */
  const open = (roomId: string, capabilities?: RoomCapabilities) => {
    const session = sessions.get(roomId);
    const release = sessions.view(session);
    const s = socket(roomId);
    if (s.readyState === 0) {
      s.open();
      s.receive('welcome', welcome(roomId, capabilities));
    }
    return { session, release };
  };
  /** Joins voice in the room and lets the room admit this tab. */
  const admit = async (roomId: string) => {
    const s = socket(roomId);
    await vi.waitFor(() => expect(s.requests.some((r) => r.type === 'voice.join')).toBe(true));
    const join = s.requests.filter((r) => r.type === 'voice.join').at(-1);
    s.receive(
      'voice.joined',
      {
        participant: {
          userId: 'u_ana',
          muted: false,
          deafened: false,
          serverMuted: false,
          joinedAt: 1,
        },
      },
      join?.id,
    );
  };
  return { sessions, sockets, created, socket, open, admit };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let current: VoiceSessions | null = null;
afterEach(() => current?.dispose());

describe('VoiceSessions', () => {
  it('keeps the voice when the page goes away, and the page reuses it when it comes back', async () => {
    const t = setup();
    current = t.sessions;
    const a = t.open('rm_a');
    t.sessions.requestJoin(a.session);
    await t.admit('rm_a');
    expect(a.session.parts.voice.getState().phase).toBe('joined');
    expect(t.sessions.getState().active).toBe(a.session);

    // Room B and then Settings: the page of A goes away, its socket stays open.
    a.release();
    const b = t.open('rm_b');
    b.release();
    await flush();
    expect(t.socket('rm_a').closedWith).toBeUndefined();
    expect(t.socket('rm_b').closedWith).toBeDefined();
    expect(t.sessions.getState()).toMatchObject({ active: a.session, viewing: [] });

    // Back to A: the same session, no second socket and no new voice.join.
    const again = t.open('rm_a');
    expect(again.session).toBe(a.session);
    expect(t.sockets.filter((s) => s.url.endsWith('rm_a'))).toHaveLength(1);
    expect(t.socket('rm_a').requests.filter((r) => r.type === 'voice.join')).toHaveLength(1);
    expect(again.session.parts.voice.getState().phase).toBe('joined');
    expect(t.sessions.getState().viewing).toEqual(['rm_a']);
  });

  it('a page without voice closes its connection when it goes away', async () => {
    const t = setup();
    current = t.sessions;
    const a = t.open('rm_a');
    a.release();
    expect(t.socket('rm_a').closedWith).toBeDefined();
    // Opening it again is a new session.
    expect(t.sessions.get('rm_a')).not.toBe(a.session);
  });

  it('joining in another room asks to switch; confirming leaves the first and joins here', async () => {
    const t = setup();
    current = t.sessions;
    const a = t.open('rm_a');
    t.sessions.requestJoin(a.session);
    await t.admit('rm_a');
    a.release();
    const b = t.open('rm_b');

    t.sessions.requestJoin(b.session);
    expect(t.sessions.getState().pendingSwitch).toEqual({ from: a.session, to: b.session });
    expect(b.session.parts.voice.getState().phase).toBe('idle');

    // Cancel keeps A.
    t.sessions.cancelSwitch();
    expect(t.sessions.getState()).toMatchObject({ pendingSwitch: null, active: a.session });

    t.sessions.requestJoin(b.session);
    t.sessions.confirmSwitch();
    expect(t.socket('rm_a').requests.some((r) => r.type === 'voice.leave')).toBe(true);
    await t.admit('rm_b');
    await flush();
    expect(t.sessions.getState().active).toBe(b.session);
    expect(b.session.parts.voice.getState().phase).toBe('joined');
    // Nobody shows A any more: its connection is closed.
    expect(t.socket('rm_a').closedWith).toBeDefined();
    expect(t.sessions.getState().notice).toBeNull();
  });

  it('disconnect from the panel leaves and closes the room nobody shows', async () => {
    const t = setup();
    current = t.sessions;
    const a = t.open('rm_a');
    t.sessions.requestJoin(a.session);
    await t.admit('rm_a');
    a.release();
    t.sessions.leave();
    await flush();
    expect(t.socket('rm_a').requests.some((r) => r.type === 'voice.leave')).toBe(true);
    expect(t.socket('rm_a').closedWith).toBeDefined();
    expect(t.sessions.getState()).toMatchObject({ active: null, notice: null });
  });

  it('leaving voice on the room page keeps the page connected', async () => {
    const t = setup();
    current = t.sessions;
    const a = t.open('rm_a');
    t.sessions.requestJoin(a.session);
    await t.admit('rm_a');
    a.session.parts.voice.leave();
    await flush();
    expect(t.sessions.getState().active).toBeNull();
    expect(t.socket('rm_a').closedWith).toBeUndefined();
  });

  it('kicked from the room (4004) while away: out of voice, closed, and a notice', async () => {
    const t = setup();
    current = t.sessions;
    const a = t.open('rm_a');
    t.sessions.requestJoin(a.session);
    await t.admit('rm_a');
    a.release();
    t.socket('rm_a').receive('kicked', { reason: 'banned' });
    t.socket('rm_a').serverClose(4004);
    await flush();
    expect(t.sessions.getState()).toMatchObject({
      active: null,
      notice: { kind: 'ended', room: 'Hangout', reason: { kind: 'kicked', reason: 'banned' } },
    });
    expect(t.sessions.get('rm_a')).not.toBe(a.session);
    t.sessions.dismissNotice();
    expect(t.sessions.getState().notice).toBeNull();
  });

  it('voice turned off in the room while away: out of voice with the reason', async () => {
    const t = setup();
    current = t.sessions;
    const a = t.open('rm_a');
    t.sessions.requestJoin(a.session);
    await t.admit('rm_a');
    a.release();
    t.socket('rm_a').receive('room.updated', {
      settings: { ...welcome('rm_a').settings, capabilities: { ...VOICE_TEXT, voice: false } },
    });
    await flush();
    expect(t.sessions.getState()).toMatchObject({
      active: null,
      notice: { kind: 'removed', reason: 'capability_disabled' },
    });
    expect(t.socket('rm_a').closedWith).toBeDefined();
  });

  it('starts the SFU session and the clients from what the room has', () => {
    const t = setup();
    current = t.sessions;
    const text = t.open('rm_b', { stream: false, voice: false, camera: false, text: true });
    const rtc = text.session.parts.rtc as ReturnType<typeof fakeRtc>;
    expect(rtc.started).toBe(0);
    const a = t.open('rm_a');
    expect((a.session.parts.rtc as ReturnType<typeof fakeRtc>).started).toBe(1);
    a.release();
    expect((a.session.parts.rtc as ReturnType<typeof fakeRtc>).closed).toBe(1);
  });
});
