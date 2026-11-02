// SPDX-License-Identifier: AGPL-3.0-only
import type { Member, RoomCapabilities, RoomSettings, Role } from '@openlive/protocol';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Membership } from '../src/api/auth.ts';
import type { Room, Space } from '../src/api/spaces.ts';
import i18n from '../src/i18n/index.ts';
import { templateOf, toggle } from '../src/lib/capabilities.ts';
import type { VoiceParticipant } from '../src/voice/contract.ts';
import { fakeApi, renderApp, USER } from './app-helpers.tsx';
import { message as chatMessage } from './chat-fakes.ts';

// A multi-step UI journey: 1-2 s on an idle machine, which can pass the 5 s default on a loaded CI
// runner.
vi.setConfig({ testTimeout: 20_000 });

// Room capabilities in the web app: the "Create room" templates,
// the room page by capability, and the helpers behind them.

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

const ALL: RoomCapabilities = { stream: true, voice: true, camera: true, text: true };
const WATCH_TOGETHER: RoomCapabilities = { stream: true, voice: true, camera: false, text: true };
const TEXT: RoomCapabilities = { stream: false, voice: false, camera: false, text: true };
const VOICE: RoomCapabilities = { stream: false, voice: true, camera: false, text: false };

const ANA: Member = { userId: USER.id, displayName: 'Ana', role: 'owner', canStream: true };
const BIA: Member = { userId: 'u_bia', displayName: 'Bia', role: 'member', canStream: false };
const CAI: Member = { userId: 'u_cai', displayName: 'Cai', role: 'guest', canStream: false };

const inVoice = (userId: string, patch: Partial<VoiceParticipant> = {}): VoiceParticipant => ({
  userId,
  muted: false,
  deafened: false,
  serverMuted: false,
  joinedAt: 0,
  ...patch,
});

/** The payloads of the messages of one type the page sent on the room socket. */
const sentOf = (socket: { sent: string[] }, type: string) =>
  socket.sent
    .map((raw) => JSON.parse(raw) as { type: string; payload: unknown })
    .filter((m) => m.type === type)
    .map((m) => m.payload);

const settings = (capabilities: RoomCapabilities): RoomSettings => ({
  maxStreams: 4,
  maxViewersPerStream: 6,
  maxBitrateKbps: 8000,
  allowedPresets: ['text', 'game'],
  capabilities,
});

const space = (capabilities: RoomCapabilities = ALL): Space => ({
  id: 'sp_1',
  name: 'Friends',
  slug: 'friends',
  ownerId: USER.id,
  plan: 'free',
  settings: {},
  createdAt: Date.UTC(2026, 9, 27),
  role: 'owner',
  effectiveSettings: settings(capabilities),
  platformCapabilities: ALL,
});

const room = (capabilities: RoomCapabilities): Room => ({
  id: 'rm_1',
  spaceId: 'sp_1',
  kind: 'fixed',
  name: 'Game night',
  slug: 'game-night',
  code: null,
  visibility: 'space',
  settings: { capabilities },
  createdBy: USER.id,
  createdAt: Date.UTC(2026, 9, 27),
  lastActiveAt: null,
  expiresAt: null,
  archivedAt: null,
  effectiveSettings: settings(capabilities),
});

const membership = (s: Space): Membership => ({
  spaceId: s.id,
  name: s.name,
  slug: s.slug,
  role: s.role ?? 'member',
});

describe('capability helpers', () => {
  it('recognizes the templates and keeps camera within voice', () => {
    expect(templateOf(WATCH_TOGETHER)).toBe('watchTogether');
    expect(templateOf({ stream: false, voice: true, camera: true, text: false })).toBe('voice');
    expect(templateOf({ stream: true, voice: false, camera: false, text: true })).toBe('custom');
    expect(toggle(WATCH_TOGETHER, 'camera', true)).toEqual({ ...WATCH_TOGETHER, camera: true });
    expect(toggle({ ...WATCH_TOGETHER, camera: true }, 'voice', false)).toEqual({
      stream: true,
      voice: false,
      camera: false,
      text: true,
    });
  });
});

describe('Create room', () => {
  async function openDialog(s: Space) {
    const calls = fakeApi({
      'GET /api/me': () => Response.json({ user: USER, memberships: [membership(s)] }),
      'GET /api/spaces/sp_1': () => Response.json({ space: s }),
      'GET /api/spaces/sp_1/rooms': () => Response.json({ rooms: [] }),
      'GET /api/spaces/sp_1/join-requests': () => Response.json({ joinRequests: [] }),
      'POST /api/spaces/sp_1/rooms': ({ body }) =>
        Response.json(
          {
            room: room(
              (body as { settings: { capabilities: RoomCapabilities } }).settings.capabilities,
            ),
          },
          { status: 201 },
        ),
      'GET /api/rooms/rm_1': () => Response.json({ room: room(WATCH_TOGETHER) }),
    });
    renderApp('/s/friends');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create room' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a room' });
    return { calls, user, dialog };
  }

  it('starts from "Watch together", marks nothing as coming soon, and sends the template', async () => {
    vi.stubGlobal('WebSocket', TestSocket);
    const { calls, user, dialog } = await openDialog(space());
    const templates = within(dialog).getByRole('radiogroup', { name: 'What the room has' });
    expect(within(templates).getByRole('radio', { name: /Watch together/ })).toBeChecked();
    for (const name of [
      'Watch together',
      'Stream only',
      'Voice channel',
      'Text channel',
      'Custom',
    ]) {
      expect(within(templates).getByText(name)).toBeInTheDocument();
    }
    // Every capability has shipped: nothing in the dialog says "Coming soon" any more.
    expect(within(dialog).queryByText('Coming soon')).toBeNull();
    expect(within(dialog).queryByText(/coming soon/i)).toBeNull();

    await user.type(within(dialog).getByLabelText('Name'), 'Talk');
    await user.click(within(templates).getByRole('radio', { name: /Voice channel/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      name: 'Talk',
      settings: { capabilities: { stream: false, voice: true, camera: false, text: false } },
    });
  });

  it('Custom shows the switches and needs at least one of stream, voice and text', async () => {
    vi.stubGlobal('WebSocket', TestSocket);
    const { user, dialog } = await openDialog(space());
    await user.type(within(dialog).getByLabelText('Name'), 'Mine');
    await user.click(within(dialog).getByRole('radio', { name: /Custom/ }));
    const fields = within(dialog).getByTestId('capability-fields');
    // Watch together carried over: stream, voice and text on.
    await user.click(within(fields).getByRole('switch', { name: /Stream/ }));
    await user.click(within(fields).getByRole('switch', { name: /Voice/ }));
    await user.click(within(fields).getByRole('switch', { name: /Text/ }));
    expect(
      within(dialog).getByText('Turn on at least one of stream, voice and text.'),
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Create room' })).toBeDisabled();
    // Camera needs voice.
    expect(within(fields).getByRole('switch', { name: /Camera/ })).toBeDisabled();
  });

  it('disables the templates the space does not allow and starts from one it does', async () => {
    vi.stubGlobal('WebSocket', TestSocket);
    const { dialog } = await openDialog(
      space({ stream: true, voice: false, camera: false, text: false }),
    );
    expect(within(dialog).getByRole('radio', { name: /Watch together/ })).toBeDisabled();
    expect(within(dialog).getByRole('radio', { name: /Voice channel/ })).toBeDisabled();
    expect(within(dialog).getByRole('radio', { name: /Stream only/ })).toBeChecked();
    expect(within(dialog).getAllByText('Not allowed in this space.')).toHaveLength(3);
  });
});

/** The browser WebSocket, replaced by one the test drives. */
class TestSocket {
  static instances: TestSocket[] = [];
  readyState = 0;
  sent: string[] = [];
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
    this.readyState = 3;
  }
  receive(type: string, payload: object) {
    act(() => this.onmessage?.({ data: JSON.stringify({ type, payload }) }));
  }
}

/** Opens the room page with the given capabilities and welcomes it on the room socket. */
async function openRoom(
  capabilities: RoomCapabilities,
  extra: { role?: Role; members?: Member[]; voice?: VoiceParticipant[] } = {},
) {
  TestSocket.instances = [];
  vi.stubGlobal('WebSocket', TestSocket);
  const s = space();
  const calls = fakeApi({
    'GET /api/me': () => Response.json({ user: USER, memberships: [membership(s)] }),
    'GET /api/spaces/sp_1': () => Response.json({ space: s }),
    'GET /api/spaces/sp_1/rooms': () => Response.json({ rooms: [room(capabilities)] }),
    'GET /api/rooms/rm_1': () => Response.json({ room: room(capabilities) }),
    'PATCH /api/rooms/rm_1': ({ body }) =>
      Response.json({
        room: room(
          (body as { settings: { capabilities: RoomCapabilities } }).settings.capabilities,
        ),
      }),
  });
  renderApp('/s/friends/r/game-night');
  // The room socket; the sidebar opens the space's presence socket too (/ws/spaces/...).
  const isRoom = (s: TestSocket) => s.url.includes('/ws/rooms/');
  await waitFor(() => expect(TestSocket.instances.some(isRoom)).toBe(true));
  const socket = TestSocket.instances.findLast(isRoom);
  if (!socket) throw new Error('no socket');
  act(() => {
    socket.readyState = 1;
    socket.onopen?.();
  });
  socket.receive('welcome', {
    protocol: { major: 1, minor: 20 },
    minProtocol: { major: 1, minor: 0 },
    serverTime: Date.now(),
    you: {
      userId: USER.id,
      connectionId: 'c_1',
      role: extra.role ?? 'owner',
      permissions: {
        canStream: true,
        canModerate: (extra.role ?? 'owner') === 'owner' || extra.role === 'admin',
      },
    },
    room: {
      roomId: 'rm_1',
      spaceId: 'sp_1',
      kind: 'fixed',
      visibility: 'space',
      name: 'Game night',
    },
    settings: settings(capabilities),
    members: extra.members ?? [
      { userId: USER.id, displayName: 'Ana', role: extra.role ?? 'owner', canStream: true },
    ],
    streams: [],
    ...(extra.voice ? { voice: extra.voice } : {}),
  });
  await screen.findByText(`${extra.members?.length ?? 1} here`);
  return { socket, calls };
}

describe('Room page by capability', () => {
  it('Watch together: the stage with Join voice, Go live and Chat by the name, the chat panel', async () => {
    await openRoom(WATCH_TOGETHER);
    expect(screen.getByRole('heading', { name: 'No one is live' })).toBeInTheDocument();
    expect(
      within(screen.getByTestId('room-stage')).getByRole('button', { name: 'Join voice' }),
    ).toBeEnabled();
    expect(screen.queryByTestId('room-controls')).not.toBeInTheDocument();
    const controls = screen.getByTestId('room-title-actions');
    expect(within(controls).getByRole('button', { name: 'Go live' })).toBeInTheDocument();
    expect(within(controls).getByRole('button', { name: 'Chat' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      within(screen.getByTestId('chat-panel')).getByRole('heading', { name: 'Chat' }),
    ).toBeVisible();
    // The owner changes the room's features.
    expect(screen.getByRole('button', { name: 'Features' })).toBeInTheDocument();
  });

  it('a text channel has no stream grid and no viewer session; room.updated brings it back', async () => {
    const { socket, calls } = await openRoom(TEXT);
    // The whole page is the chat.
    expect(screen.getByTestId('chat-page')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No one is live' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.includes('/api/rtc/'))).toBe(false);

    socket.receive('room.updated', { settings: settings({ ...TEXT, stream: true }) });
    expect(await screen.findByRole('heading', { name: 'No one is live' })).toBeInTheDocument();
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
  });

  it('a voice channel shows who is in voice as tiles, with Join voice under them', async () => {
    await openRoom(VOICE, { voice: [inVoice(USER.id)] });
    const stage = screen.getByTestId('room-stage');
    expect(within(stage).getByText('Ana')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('room-main')).getByRole('button', { name: 'Join voice' }),
    ).toBeInTheDocument();
    expect(within(stage).queryByRole('button', { name: 'Join voice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go live' })).not.toBeInTheDocument();
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No one is live' })).not.toBeInTheDocument();
  });

  it('presence lists who is in voice with their mute, deafen and server-mute icons', async () => {
    const { socket } = await openRoom(VOICE, {
      members: [ANA, BIA, CAI],
      voice: [
        inVoice('u_bia', { muted: true, deafened: true }),
        inVoice('u_cai', { serverMuted: true }),
      ],
    });
    const list = screen.getByTestId('in-voice');
    expect(screen.getByRole('list', { name: 'In voice (2)' })).toBe(list);
    const bia = list.querySelector('[data-voice-user="u_bia"]') as HTMLElement;
    expect(within(bia).getByRole('img', { name: 'Deafened' })).toBeInTheDocument();
    const cai = list.querySelector('[data-voice-user="u_cai"]') as HTMLElement;
    expect(within(cai).getByRole('img', { name: 'Muted by a moderator' })).toBeInTheDocument();

    // Live: Cai leaves, Ana joins from another tab.
    socket.receive('voice.left', { userId: 'u_cai', reason: 'left' });
    socket.receive('voice.joined', { participant: inVoice(USER.id) });
    expect(screen.getByRole('list', { name: 'In voice (2)' })).toBe(list);
    expect(list.querySelector('[data-voice-user="u_cai"]')).toBeNull();
    expect(within(list).getByText('(you)')).toBeInTheDocument();
  });

  it('an owner server-mutes and removes someone from voice', async () => {
    const { socket } = await openRoom(VOICE, { members: [ANA, BIA], voice: [inVoice('u_bia')] });
    const user = userEvent.setup();
    const list = screen.getByTestId('in-voice');
    await user.click(within(list).getByRole('button', { name: 'Voice options for Bia' }));
    expect(screen.getByText('Volume of Bia')).toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: 'Mute for everyone' }));
    expect(sentOf(socket, 'voice.serverMute')).toEqual([{ userId: 'u_bia', muted: true }]);
    await user.click(within(list).getByRole('button', { name: 'Voice options for Bia' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from voice' }));
    expect(sentOf(socket, 'voice.kick')).toEqual([{ userId: 'u_bia' }]);
  });

  it('an admin cannot moderate another admin, only set their volume', async () => {
    await openRoom(VOICE, {
      role: 'admin',
      members: [
        { ...ANA, role: 'admin' },
        { ...BIA, role: 'admin' },
      ],
      voice: [inVoice('u_bia')],
    });
    const user = userEvent.setup();
    const list = screen.getByTestId('in-voice');
    await user.click(within(list).getByRole('button', { name: 'Voice options for Bia' }));
    expect(await screen.findByText('Volume of Bia')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Mute for everyone' })).not.toBeInTheDocument();
  });

  it('turning stream off from the Features dialog warns that live streams end', async () => {
    const { socket, calls } = await openRoom(WATCH_TOGETHER);
    socket.receive('stream.started', {
      stream: {
        streamId: 'st_1',
        userId: USER.id,
        source: { kind: 'screen', label: 'Screen 1' },
        preset: 'game',
        hasAudio: false,
        paused: false,
        startedAt: Date.now(),
        viewerLimit: 6,
        viewerCount: 0,
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Features' }));
    const dialog = await screen.findByRole('dialog', { name: 'Room features' });
    // Cameras shipped (V2): the camera switch is plain, with no "coming soon" label or hint.
    expect(within(dialog).getByRole('switch', { name: 'Camera' })).toBeInTheDocument();
    expect(within(dialog).queryByText(/coming soon/i)).toBeNull();
    await user.click(within(dialog).getByRole('switch', { name: /Stream/ }));
    expect(
      within(dialog).getByText(
        'Turning stream off ends the streams that are live now, for everyone.',
      ),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      settings: { capabilities: { ...WATCH_TOGETHER, stream: false } },
    });
  });
});

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

const STREAM_ONLY: RoomCapabilities = { stream: true, voice: false, camera: false, text: false };
const VOICE_TEXT: RoomCapabilities = { stream: false, voice: true, camera: false, text: true };
const PHONE = 390;
const TABLET = 900;
const DESKTOP = 1440;

const liveStream = (userId: string, streamId = 'st_1') => ({
  stream: {
    streamId,
    userId,
    source: { kind: 'screen', label: 'Screen 1' },
    preset: 'game',
    hasAudio: false,
    paused: false,
    startedAt: Date.now(),
    viewerLimit: 6,
    viewerCount: 2,
  },
});

describe('Room page layout by capability and width', () => {
  it('phone, watch together: the tiles first, Go live and Chat by the name; no tabs', async () => {
    atWidth(PHONE);
    const { socket } = await openRoom(WATCH_TOGETHER, {
      members: [ANA, BIA],
      voice: [inVoice('u_bia', { muted: true })],
    });
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    const stage = within(screen.getByTestId('room-main')).getByTestId('room-stage');
    expect(stage.querySelector('[data-voice-user="u_bia"]')).not.toBeNull();
    // Out of voice the bottom bar is empty (hidden): no room control bar. Join voice is on the
    // page, Go live and Chat next to the name.
    const bars = screen.getByTestId('bottom-bars');
    expect(bars).toHaveClass('fixed');
    expect(bars).toBeEmptyDOMElement();
    expect(screen.getByTestId('bottom-spacer')).toBeInTheDocument();
    expect(screen.queryByTestId('room-controls')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('room-main')).getByRole('button', { name: 'Join voice' }),
    ).toBeInTheDocument();
    const controls = screen.getByTestId('room-title-actions');
    for (const name of ['Go live', 'Chat']) {
      expect(within(controls).getByRole('button', { name })).toBeInTheDocument();
    }
    // No chat panel on the page: it opens over it.
    expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();

    // A stream is a LIVE tile with a Watch action, before the people.
    socket.receive('stream.started', liveStream(BIA.userId));
    const tile = (await within(stage).findByText('Bia is streaming')).closest('[role="listitem"]');
    expect(tile).toHaveTextContent('Live');
    expect(tile).toHaveTextContent('2/6');
    expect(
      within(tile as HTMLElement).getByRole('button', { name: "Watch Bia's stream" }),
    ).toHaveTextContent('Watch');
    expect(
      (tile as HTMLElement).compareDocumentPosition(
        stage.querySelector('[data-voice-user="u_bia"]') as HTMLElement,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('desktop, watch together: the stage on the left, the chat on the right, toggled', async () => {
    atWidth(DESKTOP);
    await openRoom(WATCH_TOGETHER, { members: [ANA, BIA] });
    const aside = screen.getByRole('complementary', { name: 'Chat' });
    expect(within(aside).getByTestId('chat-panel')).toBeInTheDocument();
    // No bars fixed to the screen on desktop.
    expect(screen.queryByTestId('bottom-bars')).not.toBeInTheDocument();
    const user = userEvent.setup();
    const toggle = within(screen.getByTestId('room-title-actions')).getByRole('button', {
      name: 'Chat',
    });
    await user.click(toggle);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    const again = screen.getByRole('complementary', { name: 'Chat' });
    // The close button in the chat header hides it too.
    await user.click(within(again).getByRole('button', { name: 'Close the chat' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('Go live next to the name opens the Go live panel', async () => {
    atWidth(DESKTOP);
    await openRoom(WATCH_TOGETHER);
    const user = userEvent.setup();
    await user.click(
      within(screen.getByTestId('room-title-actions')).getByRole('button', { name: 'Go live' }),
    );
    expect(await screen.findByTestId('golive-panel')).toBeInTheDocument();
  });

  it.each([PHONE, TABLET])(
    'at %ipx the chat button opens the chat over the page, closed by its button or Escape',
    async (width) => {
      atWidth(width);
      await openRoom(WATCH_TOGETHER);
      expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();
      const user = userEvent.setup();
      const button = within(screen.getByTestId('room-title-actions')).getByRole('button', {
        name: 'Chat',
      });
      await user.click(button);
      const dialog = await screen.findByRole('dialog', { name: 'Chat' });
      expect(within(dialog).getByTestId('chat-sheet')).toBeInTheDocument();
      expect(within(dialog).getByRole('combobox', { name: 'Message' })).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Close the chat' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await user.click(button);
      await screen.findByRole('dialog', { name: 'Chat' });
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    },
  );

  it.each([PHONE, DESKTOP])('voice only at %ipx: people as tiles, no chat', async (width) => {
    atWidth(width);
    await openRoom(VOICE, { voice: [inVoice(USER.id)] });
    expect(screen.getByTestId('room-stage')).toHaveTextContent('Ana');
    expect(screen.getByRole('button', { name: 'Join voice' })).toBeInTheDocument();
    expect(screen.queryByTestId('room-title-actions')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it.each([PHONE, DESKTOP])('text only at %ipx: the page is the chat', async (width) => {
    atWidth(width);
    await openRoom(TEXT);
    expect(screen.getByTestId('chat-page')).toBeInTheDocument();
    expect(screen.queryByTestId('room-title-actions')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join voice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it.each([PHONE, DESKTOP])('stream only at %ipx: the streams and Go live', async (width) => {
    atWidth(width);
    await openRoom(STREAM_ONLY);
    expect(screen.getByText('No one is live')).toBeInTheDocument();
    const controls = screen.getByTestId('room-title-actions');
    expect(within(controls).getByRole('button', { name: 'Go live' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join voice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument();
  });

  it('voice and text: the chat button on phones, the chat column on desktop', async () => {
    atWidth(PHONE);
    await openRoom(VOICE_TEXT);
    expect(
      within(screen.getByTestId('room-title-actions')).getByRole('button', { name: 'Chat' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();
    cleanup();
    atWidth(DESKTOP);
    await openRoom(VOICE_TEXT);
    expect(screen.getByRole('complementary', { name: 'Chat' })).toBeInTheDocument();
  });

  it.each([PHONE, DESKTOP])(
    'at %ipx the room is as tall as the screen: the stage and 50 messages scroll inside',
    async (width) => {
      atWidth(width);
      const { socket } = await openRoom(ALL, {
        members: [ANA, BIA, CAI],
        voice: [inVoice('u_bia'), inVoice('u_cai')],
      });
      // The chat's first page answers its history request: 50 long messages.
      await waitFor(() => expect(sentOf(socket, 'chat.history')).toHaveLength(1));
      const history = socket.sent
        .map((raw) => JSON.parse(raw) as { type: string; id?: string })
        .find((m) => m.type === 'chat.history');
      const messages = Array.from({ length: 50 }, (_, i) => ({
        ...chatMessage(i + 1),
        text: `A long message number ${i + 1}. `.repeat(4),
      }));
      act(() =>
        socket.onmessage?.({
          data: JSON.stringify({
            type: 'chat.page',
            id: history?.id,
            payload: { messages, hasMore: false },
          }),
        }),
      );
      // The page has the screen's height below the top bar and never grows with its content.
      const page = screen.getByTestId('room-body').closest('[data-fill]') as HTMLElement;
      expect(page).toHaveClass('h-[calc(100dvh-var(--header-height)-0.5rem-2px)]', 'min-h-0');
      expect(page.lastElementChild).toHaveClass('min-h-0', 'overflow-hidden');
      expect(screen.getByTestId('room-body')).toHaveClass('min-h-0', 'flex-1');
      // The stage scrolls in its column.
      expect(screen.getByTestId('room-scroll')).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
      if (width === DESKTOP) {
        // The chat fills its column; its messages scroll, the composer stays in sight.
        const aside = screen.getByRole('complementary', { name: 'Chat' });
        expect(aside).toHaveClass('min-h-0');
        expect(aside).not.toHaveClass('sticky');
        const log = within(aside).getByRole('log', { name: 'Chat' });
        expect(log.querySelectorAll('li')).toHaveLength(50);
        expect(log.parentElement).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
        expect(within(aside).getByRole('combobox', { name: 'Message' })).toBeInTheDocument();
      } else {
        expect(screen.getByTestId('bottom-bars')).toHaveClass('fixed');
      }
    },
  );

  it("the sidebar lists the space's rooms, the open one marked", async () => {
    atWidth(DESKTOP);
    await openRoom(WATCH_TOGETHER);
    const nav = await screen.findByRole('navigation', { name: 'Rooms in Friends' });
    const link = within(nav).getByRole('link', { name: 'Game night' });
    expect(link).toHaveAttribute('href', '/s/friends/r/game-night');
    expect(link).toHaveAttribute('data-active', 'true');
  });
});
