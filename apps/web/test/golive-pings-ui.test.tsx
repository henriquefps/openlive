// SPDX-License-Identifier: AGPL-3.0-only
import type { HelperInfo, RoomSettings, StreamInfo } from '@openlive/protocol';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GoLiveArea } from '../src/golive/GoLive.tsx';
import type { HubConnection } from '../src/hub/connection.ts';
import { HubContext } from '../src/hub/use-hub.ts';
import { PointerSettingsCard } from '../src/pointer/PointerSettingsCard.tsx';
import type { PointerSocket } from '../src/pointer/socket.ts';
import { pointerStyle } from '../src/pointer/style.ts';
import type { FakeSocket } from './fake-socket.ts';
import { connectedHub, PC } from './hub-fakes.ts';

// "Allow visual clicks" (docs/PROTOCOL.md 7.9): the switch in the Go live panel, which applies
// once the stream is in the room, and the one in the live controls; and Settings → Pointer.

const SETTINGS: RoomSettings = {
  maxStreams: 4,
  maxViewersPerStream: 6,
  maxBitrateKbps: 20000,
  allowedPresets: ['text', 'game', 'max'],
};

const STREAM: StreamInfo = {
  streamId: 'st_1',
  userId: 'u_ana',
  deviceId: 'd_pc',
  source: { kind: 'screen', label: 'Test pattern' },
  preset: 'game',
  hasAudio: false,
  paused: false,
  startedAt: 0,
  viewerLimit: 6,
  viewerCount: 0,
};

/** The room's streams as the room socket would have them, changed by the test. */
function roomStreams() {
  let streams: StreamInfo[] = [];
  const listeners = new Set<() => void>();
  return {
    get: () => streams,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set: (next: StreamInfo[]) =>
      act(() => {
        streams = next;
        for (const l of listeners) l();
      }),
  };
}

function fakePointer() {
  const setPings = vi.fn<PointerSocket['setPings']>();
  const pointer: PointerSocket = {
    ping: vi.fn(() => true),
    setPings,
    onRejected: vi.fn(() => () => undefined),
  };
  return { pointer, setPings };
}

async function renderArea(hub: HubConnection, room: ReturnType<typeof roomStreams>) {
  const { pointer, setPings } = fakePointer();
  function Area() {
    const streams = useSyncExternalStore(room.subscribe, room.get);
    return (
      <HubContext value={hub}>
        <GoLiveArea
          roomId="rm_1"
          settings={SETTINGS}
          canStream
          pings={{ streams, selfId: 'u_ana', pointer }}
        />
      </HubContext>
    );
  }
  const rootRoute = createRootRoute({ component: Area });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() });
  render(<RouterProvider router={router} />);
  await screen.findByRole('button', { name: 'Go live' });
  return { setPings };
}

const reply = (socket: FakeSocket, type: string, payload: object, id?: string) =>
  act(() => socket.receive(type, payload, id));

/** Opens the panel and gets to the options of the test source. */
async function toOptions(socket: FakeSocket) {
  await userEvent.click(screen.getByRole('button', { name: 'Go live' }));
  await reply(
    socket,
    'helper.sources',
    {
      deviceId: 'd_pc',
      sources: [{ sourceId: 'test', kind: 'screen', label: 'Test pattern', hasAudio: false }],
    },
    socket.requests.at(-1)?.id,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Test pattern' }));
}

async function goLive(socket: FakeSocket) {
  await userEvent.click(screen.getByRole('button', { name: 'Start streaming' }));
  const start = socket.requests.at(-1);
  await reply(socket, 'helper.status', {
    deviceId: 'd_pc',
    state: 'live',
    stream: { roomId: 'rm_1', streamId: 'st_1', sourceId: 'test', preset: 'game' },
  });
  await reply(socket, 'ack', {}, start?.id);
}

describe('Allow visual clicks', () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });

  it('is off by default, and once chosen turns on when the stream can draw them', async () => {
    const { hub, socket } = connectedHub();
    const room = roomStreams();
    const pointer = await renderArea(hub, room);
    await toOptions(socket);
    const toggle = screen.getByRole('switch', { name: 'Allow visual clicks' });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await goLive(socket);
    expect(pointer.setPings).not.toHaveBeenCalled();

    // The stream shows up in the room with a helper that draws clicks: turned on, once.
    room.set([{ ...STREAM, pingOverlay: true }]);
    expect(pointer.setPings).toHaveBeenCalledExactlyOnceWith('st_1', true);
    room.set([{ ...STREAM, pingOverlay: true, pings: true }]);
    expect(pointer.setPings).toHaveBeenCalledOnce();

    // The live controls show the switch on, and turning it off sends it.
    const live = screen.getByTestId('golive-live');
    const liveToggle = within(live).getByRole('switch', { name: 'Allow visual clicks' });
    expect(liveToggle).toBeChecked();
    await userEvent.click(liveToggle);
    expect(pointer.setPings).toHaveBeenLastCalledWith('st_1', false);
  });

  it('drops the choice silently when the helper cannot draw, and hides the live switch', async () => {
    const { hub, socket } = connectedHub();
    const room = roomStreams();
    const pointer = await renderArea(hub, room);
    await toOptions(socket);
    await userEvent.click(screen.getByRole('switch', { name: 'Allow visual clicks' }));
    await goLive(socket);
    room.set([STREAM]);
    expect(pointer.setPings).not.toHaveBeenCalled();
    const live = screen.getByTestId('golive-live');
    expect(within(live).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(live).getByText(/need a helper that can draw them/)).toBeInTheDocument();
  });

  it('is not offered for a macOS helper or one before protocol 1.20', async () => {
    for (const helper of [
      { ...PC, os: 'macos' },
      { ...PC, protocol: { major: 1, minor: 19 } },
    ] satisfies HelperInfo[]) {
      const { hub, socket } = connectedHub([helper]);
      await renderArea(hub, roomStreams());
      await toOptions(socket);
      expect(screen.queryByRole('switch', { name: 'Allow visual clicks' })).not.toBeInTheDocument();
      cleanup();
    }
  });
});

describe('Settings → Pointer', () => {
  it('picks a color and a shape with a live preview, olive ring by default', async () => {
    pointerStyle.update({ color: 'olive', shape: 'ring' });
    render(<PointerSettingsCard />);
    const preview = screen.getByTestId('pointer-preview');
    expect(preview).toHaveAccessibleName('Preview: Olive Ring');
    expect(screen.getByRole('radio', { name: 'Olive' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('radio', { name: 'Cyan' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Star' }));
    expect(pointerStyle.get()).toEqual({ color: 'cyan', shape: 'star' });
    expect(preview).toHaveAccessibleName('Preview: Cyan Star');
    const marker = within(preview).getByText('You').closest('[data-slot="ping-indicator"]');
    expect(marker).toHaveAttribute('data-shape', 'star');
    expect(marker).toHaveAttribute('data-color', 'cyan');
    pointerStyle.update({ color: 'olive', shape: 'ring' });
  });
});
