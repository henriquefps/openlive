// SPDX-License-Identifier: AGPL-3.0-only
import type { Member, RoomCapabilities, RoomSettings } from '@openlive/protocol';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership } from '../src/api/auth.ts';
import type { Room, Space } from '../src/api/spaces.ts';
import i18n from '../src/i18n/index.ts';
import { fakeApi, renderApp, USER } from './app-helpers.tsx';

// A multi-step UI journey: 1-2 s on an idle machine, which can pass the 5 s default on a loaded CI
// runner.
vi.setConfig({ testTimeout: 20_000 });

// The app-wide voice session in the whole app (voice/session.ts, VoiceConnected.tsx): join voice
// in a room, browse to another room and to Settings with the voice still on, the "Voice
// connected" panel in the sidebar (desktop) or above the bottom of the screen (phones), back to the
// room without joining again, switching rooms, disconnect, and a kick while away.

// No Web Audio in jsdom: the speakers and the level meter are stubs.
vi.mock('../src/voice/audio.ts', () => ({
  canPickSink: () => false,
  AudioPlayback: class {
    canPickSink = false;
    attach() {}
    detach() {}
    setVolume() {}
    setDeafened() {}
    setSink() {
      return Promise.resolve(false);
    }
    resume() {}
    dispose() {}
  },
}));
vi.mock('../src/voice/levels.ts', () => ({
  LevelMonitor: class {
    add() {}
    remove() {}
    dispose() {}
  },
}));

const VOICE: RoomCapabilities = { stream: false, voice: true, camera: true, text: false };

const settings = (capabilities: RoomCapabilities): RoomSettings => ({
  maxStreams: 4,
  maxViewersPerStream: 6,
  maxBitrateKbps: 8000,
  allowedPresets: ['text', 'game'],
  capabilities,
});

const SPACE: Space = {
  id: 'sp_1',
  name: 'Friends',
  slug: 'friends',
  ownerId: USER.id,
  plan: 'free',
  settings: {},
  createdAt: Date.UTC(2026, 9, 27),
  role: 'owner',
  effectiveSettings: settings(VOICE),
  platformCapabilities: { stream: true, voice: true, camera: true, text: true },
};

const room = (id: string, name: string, slug: string): Room => ({
  id,
  spaceId: 'sp_1',
  kind: 'fixed',
  name,
  slug,
  code: null,
  visibility: 'space',
  settings: { capabilities: VOICE },
  createdBy: USER.id,
  createdAt: Date.UTC(2026, 9, 27),
  lastActiveAt: null,
  expiresAt: null,
  archivedAt: null,
  effectiveSettings: settings(VOICE),
});
const HANGOUT = room('rm_a', 'Hangout', 'hangout');
const GAMES = room('rm_b', 'Games', 'games');
const ROOMS = [HANGOUT, GAMES];

const membership: Membership = { spaceId: 'sp_1', name: 'Friends', slug: 'friends', role: 'owner' };
const ANA: Member = { userId: USER.id, displayName: 'Ana', role: 'owner', canStream: true };

/** The browser WebSocket, replaced by one the test drives. */
class TestSocket {
  static instances: TestSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    TestSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  receive(type: string, payload: object, id?: string) {
    act(() => this.onmessage?.({ data: JSON.stringify({ type, payload, id }) }));
  }
  get messages() {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string; id?: string });
  }
  /** Opens and welcomes the socket of a room. */
  welcome() {
    const r = ROOMS.find((x) => this.url.endsWith(x.id)) ?? HANGOUT;
    act(() => {
      this.readyState = 1;
      this.onopen?.();
    });
    this.receive('welcome', {
      protocol: { major: 1, minor: 12 },
      minProtocol: { major: 1, minor: 0 },
      serverTime: Date.now(),
      you: {
        userId: USER.id,
        connectionId: `c_${r.id}`,
        role: 'owner',
        permissions: { canStream: true, canModerate: true, canUseCamera: true },
      },
      room: { roomId: r.id, spaceId: 'sp_1', kind: 'fixed', visibility: 'space', name: r.name },
      settings: settings(VOICE),
      members: [ANA],
      streams: [],
    });
  }
  /** The room admits this tab to voice. */
  admit() {
    const join = this.messages.filter((m) => m.type === 'voice.join').at(-1);
    this.receive(
      'voice.joined',
      {
        participant: {
          userId: USER.id,
          muted: false,
          deafened: false,
          serverMuted: false,
          joinedAt: 1,
        },
      },
      join?.id,
    );
  }
}

const socketOf = (roomId: string) => {
  const found = TestSocket.instances.filter((s) => s.url.endsWith(roomId)).at(-1);
  if (!found) throw new Error(`no socket for ${roomId}`);
  return found;
};
const socketsOf = (roomId: string) => TestSocket.instances.filter((s) => s.url.endsWith(roomId));

/** Pretends the window is `width` px wide for the (max-width) queries of the layout. */
function atWidth(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as MediaQueryList;
  });
}

beforeEach(() => {
  TestSocket.instances = [];
  vi.stubGlobal('WebSocket', TestSocket);
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: () => Promise.resolve({ release: () => Promise.resolve() }),
    },
  });
  fakeApi({
    'GET /api/me': () => Response.json({ user: USER, memberships: [membership] }),
    'GET /api/spaces/sp_1': () => Response.json({ space: SPACE }),
    'GET /api/spaces/sp_1/rooms': () => Response.json({ rooms: ROOMS }),
    'GET /api/spaces/sp_1/join-requests': () => Response.json({ joinRequests: [] }),
    'GET /api/rooms/rm_a': () => Response.json({ room: HANGOUT }),
    'GET /api/rooms/rm_b': () => Response.json({ room: GAMES }),
    'GET /api/me/sessions': () => Response.json({ sessions: [] }),
    'GET /api/me/devices': () => Response.json({ devices: [] }),
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

/** Opens Hangout, joins its voice and lets the room admit this tab. */
async function inVoiceInHangout() {
  const router = renderApp('/s/friends/r/hangout');
  // The whole app's first render: slower than a second under a full parallel test run.
  await waitFor(() => expect(socketsOf('rm_a')).toHaveLength(1), { timeout: 3_000 });
  socketOf('rm_a').welcome();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Join voice' }));
  await waitFor(() =>
    expect(socketOf('rm_a').messages.some((m) => m.type === 'voice.join')).toBe(true),
  );
  socketOf('rm_a').admit();
  await waitFor(() => expect(voicePanel()).toHaveAttribute('data-phase', 'joined'));
  return { router, user };
}

/** The "Voice connected" panel: the sidebar's on desktop, the bottom bar on phones. */
const voicePanel = () =>
  screen.queryByTestId('voice-connected-sidebar') ?? screen.getByTestId('voice-connected-bar');

const go = async (router: Awaited<ReturnType<typeof inVoiceInHangout>>['router'], to: string) => {
  await act(() => router.navigate({ to }));
};

describe('Voice connected (desktop)', () => {
  it('stays in voice through another room and Settings, and comes back without joining again', async () => {
    const { router, user } = await inVoiceInHangout();
    // On the room page too, the sidebar says where the voice is.
    const panel = await screen.findByTestId('voice-connected-sidebar');
    expect(panel).toHaveAccessibleName('Voice connected in Hangout');
    // The only voice controls: mute, deafen, the camera and disconnect; none in the room.
    expect(
      within(panel)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Mute', 'Deafen', 'Turn camera on', 'Disconnect']);
    expect(screen.getAllByRole('toolbar', { name: 'Voice controls' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Join voice' })).not.toBeInTheDocument();
    expect(screen.queryByText('Mic on')).not.toBeInTheDocument();

    await go(router, '/s/friends/r/games');
    await waitFor(() => expect(socketsOf('rm_b')).toHaveLength(1));
    socketOf('rm_b').welcome();
    await screen.findByRole('heading', { name: 'Games' });
    await go(router, '/settings');
    await waitFor(() => expect(socketOf('rm_b').closed).toBe(true));

    const sidebar = screen.getByTestId('voice-connected-sidebar');
    expect(within(sidebar).getByRole('status')).toHaveTextContent('Voice connected');
    expect(socketOf('rm_a').closed).toBe(false);
    // Mute and deafen from the panel go to the room.
    await user.click(within(sidebar).getByRole('button', { name: 'Deafen' }));
    expect(
      socketOf('rm_a')
        .sent.map((raw) => JSON.parse(raw) as { type: string; payload: unknown })
        .filter((m) => m.type === 'voice.state')
        .at(-1)?.payload,
    ).toEqual({ muted: true, deafened: true });
    expect(within(sidebar).getByRole('button', { name: 'Undeafen' })).toBeInTheDocument();

    // The room's name leads back; the same socket, still in voice.
    await user.click(within(sidebar).getByRole('link', { name: 'Go to Hangout' }));
    await screen.findByRole('heading', { name: 'Hangout' });
    expect(socketsOf('rm_a')).toHaveLength(1);
    expect(socketOf('rm_a').messages.filter((m) => m.type === 'voice.join')).toHaveLength(1);
    expect(voicePanel()).toHaveAttribute('data-phase', 'joined');
    // In voice, the room has no Join voice and no voice controls of its own: the panel has them.
    expect(screen.queryByRole('button', { name: 'Join voice' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('toolbar', { name: 'Voice controls' })).toHaveLength(1);
  });

  it('disconnect leaves and closes the room nobody shows', async () => {
    const { router, user } = await inVoiceInHangout();
    await go(router, '/settings');
    const sidebar = await screen.findByTestId('voice-connected-sidebar');
    await user.click(within(sidebar).getByRole('button', { name: 'Disconnect' }));
    expect(socketOf('rm_a').messages.some((m) => m.type === 'voice.leave')).toBe(true);
    await waitFor(() => expect(socketOf('rm_a').closed).toBe(true));
    expect(screen.queryByTestId('voice-connected-sidebar')).not.toBeInTheDocument();
  });

  it('joining in another room asks to switch, then leaves the first', async () => {
    const { router, user } = await inVoiceInHangout();
    await go(router, '/s/friends/r/games');
    await waitFor(() => expect(socketsOf('rm_b')).toHaveLength(1));
    socketOf('rm_b').welcome();
    await user.click(await screen.findByRole('button', { name: 'Join voice' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Games?' });
    expect(dialog).toHaveTextContent('You will leave the voice in Hangout.');
    expect(socketOf('rm_b').messages.some((m) => m.type === 'voice.join')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Switch' }));
    expect(socketOf('rm_a').messages.some((m) => m.type === 'voice.leave')).toBe(true);
    await waitFor(() =>
      expect(socketOf('rm_b').messages.some((m) => m.type === 'voice.join')).toBe(true),
    );
    socketOf('rm_b').admit();
    await waitFor(() => expect(socketOf('rm_a').closed).toBe(true));
    expect(await screen.findByTestId('voice-connected-sidebar')).toHaveAccessibleName(
      'Voice connected in Games',
    );
  });

  it('removed from the room while away: the voice ends and a toast says so', async () => {
    const { router } = await inVoiceInHangout();
    await go(router, '/settings');
    await screen.findByTestId('voice-connected-sidebar');
    socketOf('rm_a').receive('kicked', { reason: 'banned' });
    act(() => {
      socketOf('rm_a').readyState = 3;
      socketOf('rm_a').onclose?.({ code: 4004 });
    });
    expect(await screen.findByText('You were removed from the room')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId('voice-connected-sidebar')).not.toBeInTheDocument(),
    );
  });

  it('speaks Portuguese', async () => {
    const { router } = await inVoiceInHangout();
    await go(router, '/settings');
    await act(() => i18n.changeLanguage('pt-BR'));
    const sidebar = await screen.findByTestId('voice-connected-sidebar');
    expect(sidebar).toHaveAccessibleName('Voz conectada em Hangout');
    expect(within(sidebar).getByRole('button', { name: 'Desconectar' })).toBeInTheDocument();
  });
});

describe('Voice connected (phone)', () => {
  it('the bottom bar with exactly 4 buttons, on the room page too, and away from it', async () => {
    atWidth(390);
    const { router } = await inVoiceInHangout();
    // On the room's own page the bottom bar is the panel (the room has no control bar).
    expect(screen.queryByTestId('voice-connected-sidebar')).not.toBeInTheDocument();
    const roomBars = screen.getByTestId('bottom-bars');
    const here = within(roomBars).getByTestId('voice-connected-bar');
    expect(
      within(here)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Mute', 'Deafen', 'Turn camera on', 'Disconnect']);
    expect(screen.queryByTestId('room-controls')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join voice' })).not.toBeInTheDocument();

    await go(router, '/settings');
    const shellBars = await screen.findByTestId('shell-bottom-bars');
    expect(shellBars).toHaveClass('fixed');
    const bar = within(shellBars).getByTestId('voice-connected-bar');
    expect(bar).toHaveTextContent('Voice connected');
    expect(within(bar).getByRole('link', { name: 'Go to Hangout' })).toBeInTheDocument();
    expect(within(bar).getAllByRole('button')).toHaveLength(4);

    // Another room: its own bottom bar has the panel, one set of fixed bars; Join voice there.
    await go(router, '/s/friends/r/games');
    await waitFor(() => expect(socketsOf('rm_b')).toHaveLength(1));
    socketOf('rm_b').welcome();
    const pageBars = await screen.findByTestId('bottom-bars');
    expect(within(pageBars).getByTestId('voice-connected-bar')).toHaveAccessibleName(
      'Voice connected in Hangout',
    );
    expect(await screen.findByRole('button', { name: 'Join voice' })).toBeInTheDocument();
    expect(screen.queryByTestId('shell-bottom-bars')).not.toBeInTheDocument();
    expect(socketOf('rm_a').closed).toBe(false);
  });
});
