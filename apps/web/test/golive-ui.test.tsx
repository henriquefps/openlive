// SPDX-License-Identifier: AGPL-3.0-only
import type { RoomSettings } from '@openlive/protocol';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type BrowserContext, GoLiveArea } from '../src/golive/GoLive.tsx';
import type { HubConnection } from '../src/hub/connection.ts';
import { HubContext } from '../src/hub/use-hub.ts';
import type { FakeSocket } from './fake-socket.ts';
import { connectedHub, PC } from './hub-fakes.ts';

// The room's Go live panel and live controls, against a hub connection on
// a fake socket: what the tab sends, and what it shows for the helper's replies and status.

const SETTINGS: RoomSettings = {
  maxStreams: 4,
  maxViewersPerStream: 6,
  maxBitrateKbps: 13000,
  allowedPresets: ['text', 'game', 'max'],
};

async function renderArea(
  hub: HubConnection,
  props: { canStream?: boolean; settings?: RoomSettings; browser?: BrowserContext } = {},
) {
  const rootRoute = createRootRoute({
    component: () => (
      <HubContext value={hub}>
        <GoLiveArea
          roomId="rm_1"
          settings={props.settings ?? SETTINGS}
          canStream={props.canStream ?? true}
          {...(props.browser ? { browser: props.browser } : {})}
        />
      </HubContext>
    ),
  });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() });
  render(<RouterProvider router={router} />);
  return screen.findByRole('button', { name: 'Go live' });
}

/** The last command the tab sent, as the hub would forward it. */
function lastCommand(socket: FakeSocket) {
  const request = socket.requests.at(-1);
  if (!request) throw new Error('no request');
  return request;
}

const reply = (socket: FakeSocket, type: string, payload: object, id?: string) =>
  act(() => socket.receive(type, payload, id));

describe('Go live', () => {
  beforeAll(() => {
    // Radix Select reads these; jsdom has none.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });

  it('runs helper → source (with thumbnail) → options → start, then shows the live controls', async () => {
    const { hub, socket } = connectedHub();
    await userEvent.click(await renderArea(hub));

    // The only helper is picked by itself; it is asked for its sources with thumbnails.
    const list = lastCommand(socket);
    expect(list).toMatchObject({
      type: 'helper.listSources',
      payload: { deviceId: 'd_pc', thumbnails: true },
    });
    expect(screen.getByText('Asking your helper for its screens and windows…')).toBeInTheDocument();
    await reply(
      socket,
      'helper.sources',
      {
        deviceId: 'd_pc',
        sources: [
          { sourceId: 'test', kind: 'screen', label: 'Test pattern', hasAudio: true },
          { sourceId: 'portal:window', kind: 'window', label: 'Choose', hasAudio: false },
        ],
      },
      list.id,
    );
    await reply(socket, 'helper.sourceThumbnail', {
      deviceId: 'd_pc',
      sourceId: 'test',
      mimeType: 'image/jpeg',
      width: 320,
      height: 180,
      data: 'AAAA',
    });
    const testSource = screen.getByRole('button', { name: 'Test pattern' });
    expect(within(testSource).getByRole('presentation')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,AAAA',
    );
    expect(
      screen.getByRole('button', { name: 'Choose a window in the system dialog' }),
    ).toBeInTheDocument();
    await userEvent.click(testSource);

    // Options: game by default, its upload need, max allowed, native not offered.
    expect(screen.getByRole('combobox', { name: 'Resolution' })).toHaveTextContent('1080p');
    expect(screen.getByRole('combobox', { name: 'Frame rate (FPS)' })).toHaveTextContent('60');
    // Native is off in this room: there is no 4K to pick.
    await userEvent.click(screen.getByRole('combobox', { name: 'Resolution' }));
    expect(screen.queryByRole('option', { name: /4K/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Needs about 16\.4 Mb\/s of upload\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: '1440p' }));
    expect(screen.getByText(/This room limits streams to 13 Mb\/s\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start streaming' }));

    const start = lastCommand(socket);
    expect(start).toMatchObject({
      type: 'helper.startStream',
      payload: { deviceId: 'd_pc', roomId: 'rm_1', sourceId: 'test', preset: 'max', audio: true },
    });
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    await reply(socket, 'helper.status', {
      deviceId: 'd_pc',
      state: 'live',
      stream: { roomId: 'rm_1', streamId: 'st_1', sourceId: 'test', preset: 'max' },
    });
    await reply(socket, 'ack', {}, start.id);
    await reply(socket, 'helper.stats', {
      deviceId: 'd_pc',
      streamId: 'st_1',
      targetBitrateKbps: 12000,
      sentBitrateKbps: 11800,
      fps: 59.9,
      width: 2560,
      height: 1440,
      packetLossPct: 0.2,
      rttMs: 0,
      encoder: 'nvh264',
      layers: [
        {
          rid: 'f',
          width: 2560,
          height: 1440,
          fps: 60,
          targetBitrateKbps: 8000,
          sentBitrateKbps: 7900,
        },
      ],
    });

    const live = screen.getByTestId('golive-live');
    expect(within(live).getByText('You are live')).toBeInTheDocument();
    expect(within(live).getByText("Streaming from Ana's PC")).toBeInTheDocument();
    expect(within(live).getByText('2560×1440 at 60 fps')).toBeInTheDocument();
    expect(within(live).getByText('nvh264')).toBeInTheDocument();

    // Pause, then stop.
    await userEvent.click(within(live).getByRole('button', { name: 'Pause (privacy curtain)' }));
    const pause = lastCommand(socket);
    expect(pause).toMatchObject({
      type: 'helper.pauseStream',
      payload: { deviceId: 'd_pc', paused: true },
    });
    await reply(socket, 'ack', {}, pause.id);
    await reply(socket, 'helper.status', {
      deviceId: 'd_pc',
      state: 'paused',
      stream: {
        roomId: 'rm_1',
        streamId: 'st_1',
        sourceId: 'test',
        preset: 'max',
        pauseReason: 'privacy_curtain',
      },
    });
    expect(screen.getByTestId('golive-live')).toHaveAttribute('data-state', 'paused');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Stop streaming' }));
    const stop = lastCommand(socket);
    expect(stop).toMatchObject({ type: 'helper.stopStream', payload: { deviceId: 'd_pc' } });
    await reply(socket, 'helper.status', { deviceId: 'd_pc', state: 'idle' });
    await reply(socket, 'ack', {}, stop.id);
    expect(await screen.findByRole('button', { name: 'Go live' })).toBeInTheDocument();
  });

  it('explains a guest without the stream permission', async () => {
    const { hub } = connectedHub();
    await userEvent.click(await renderArea(hub, { canStream: false }));
    expect(screen.getByText('You cannot stream here yet')).toBeInTheDocument();
  });

  it('leads with installing the helper when none is online, with the way to get one', async () => {
    const { hub } = connectedHub([]);
    await userEvent.click(await renderArea(hub));
    expect(screen.getByText('Install the helper (recommended)')).toBeInTheDocument();
    expect(screen.getByText('Up to 1440p and 120 fps')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download the helper' })).toHaveAttribute(
      'href',
      '/download',
    );
    // No browser context (or no getDisplayMedia): no browser option.
    expect(screen.queryByRole('button', { name: 'Stream from the browser' })).toBeNull();
  });

  describe('from the browser', () => {
    const context: BrowserContext = {
      socket: { listen: () => () => {}, sendRequest: () => null, onEnded: () => () => {} },
      hold: () => () => {},
    };
    const withDisplayMedia = () =>
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getDisplayMedia: vi.fn() },
      });
    afterEach(() => {
      Reflect.deleteProperty(navigator, 'mediaDevices');
      vi.restoreAllMocks();
    });

    it('offers the browser as the second choice without a helper, limited to 1080p60', async () => {
      withDisplayMedia();
      const { hub } = connectedHub([]);
      await userEvent.click(await renderArea(hub, { browser: context }));
      expect(screen.getByText('Install the helper (recommended)')).toBeInTheDocument();
      expect(
        screen.getByText('Limited quality (up to 1080p60). Keep this tab open while you stream.'),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Stream from the browser' }));
      const step = screen.getByTestId('golive-browser');
      expect(within(step).getByRole('button', { name: 'Start streaming' })).toBeEnabled();
      // Only 1080p: no 1440p in the resolution select.
      await userEvent.click(within(step).getByRole('combobox', { name: 'Resolution' }));
      expect(screen.queryByRole('option', { name: '1440p' })).toBeNull();
    });

    it('says the Windows helper is not available yet instead of a download', async () => {
      withDisplayMedia();
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
      );
      const { hub } = connectedHub([]);
      await userEvent.click(await renderArea(hub, { browser: context }));
      expect(screen.getByTestId('golive-no-windows-helper')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Download the helper' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Stream from the browser' })).toBeInTheDocument();
    });

    it('keeps the helper flow when one is online, with a discreet link to the browser', async () => {
      withDisplayMedia();
      const { hub } = connectedHub();
      await userEvent.click(await renderArea(hub, { browser: context }));
      expect(
        screen.getByText('Asking your helper for its screens and windows…'),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByTestId('golive-browser-link'));
      expect(screen.getByTestId('golive-browser')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.queryByTestId('golive-browser')).toBeNull();
    });
  });

  it('lets the user choose among helpers and marks outdated and busy ones', async () => {
    const outdated = {
      ...PC,
      deviceId: 'd_old',
      name: 'Old laptop',
      protocol: { major: 1, minor: 1 },
    };
    const busy = { ...PC, deviceId: 'd_busy', name: 'Busy desktop' };
    const { hub, socket } = connectedHub([PC, outdated, busy]);
    socket.receive('helper.status', {
      deviceId: 'd_busy',
      state: 'live',
      stream: { roomId: 'rm_other', sourceId: 'test', preset: 'game' },
    });
    await userEvent.click(await renderArea(hub));
    expect(
      screen.getByRole('button', { name: /Busy desktop.*Streaming elsewhere/ }),
    ).toBeDisabled();
    const old = screen.getByRole('button', { name: /Old laptop.*Update available/ });
    await userEvent.click(old);
    expect(lastCommand(socket).payload).toEqual({ deviceId: 'd_old', thumbnails: true });
  });

  it('shows a quota block and a busy helper as their own failures', async () => {
    const { hub, socket } = connectedHub();
    await userEvent.click(await renderArea(hub));
    await reply(
      socket,
      'helper.sources',
      {
        deviceId: 'd_pc',
        sources: [{ sourceId: 'test', kind: 'screen', label: 'Test pattern', hasAudio: true }],
      },
      lastCommand(socket).id,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Test pattern' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start streaming' }));
    await reply(socket, 'error', { code: 'quota_exhausted' }, lastCommand(socket).id);
    expect(await screen.findByText('Streaming is blocked for now')).toBeInTheDocument();
    expect(
      screen.getByText('This space has used up its bandwidth for the month.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Start streaming' }));
    await reply(socket, 'error', { code: 'helper_busy', deviceId: 'd_pc' }, lastCommand(socket).id);
    await waitFor(() => expect(screen.getByText('Your helper is busy')).toBeInTheDocument());
  });

  it('offers the system dialog and the last shared window apart, and starts the one picked', async () => {
    const { hub, socket } = connectedHub();
    await userEvent.click(await renderArea(hub));
    await reply(
      socket,
      'helper.sources',
      {
        deviceId: 'd_pc',
        sources: [
          { sourceId: 'portal:screen', kind: 'screen', label: 'A monitor', hasAudio: false },
          { sourceId: 'portal:window', kind: 'window', label: 'A window', hasAudio: true },
          {
            sourceId: 'portal:window:last',
            kind: 'window',
            label: 'Docs — Firefox',
            appName: 'firefox',
            hasAudio: true,
            restored: true,
          },
        ],
      },
      lastCommand(socket).id,
    );
    expect(
      screen.getByRole('button', { name: 'Choose a screen in the system dialog' }),
    ).toBeInTheDocument();
    // "Choose a window…" always opens the dialog: it starts portal:window, never the restored one.
    await userEvent.click(
      screen.getByRole('button', { name: 'Choose a window in the system dialog' }),
    );
    expect(
      screen.getByText(/Your system shows its own dialog on the computer/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start streaming' }));
    expect(lastCommand(socket)).toMatchObject({
      type: 'helper.startStream',
      payload: { sourceId: 'portal:window', audio: true },
    });
    await reply(socket, 'error', { code: 'internal_error' }, lastCommand(socket).id);

    // The last window is its own choice, named, and says it skips the dialog.
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Last: Docs — Firefox' }));
    expect(screen.getByText(/Shares this again without the system dialog/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start streaming' }));
    expect(lastCommand(socket)).toMatchObject({
      type: 'helper.startStream',
      payload: { sourceId: 'portal:window:last', audio: true },
    });
  });

  it('picks quality with resolution and frame rate selects, without a per-viewer estimate', async () => {
    const { hub, socket } = connectedHub();
    const settings: RoomSettings = {
      ...SETTINGS,
      allowedPresets: ['text', 'game', 'max', 'game120', 'max120'],
    };
    await userEvent.click(await renderArea(hub, { settings }));
    const list = lastCommand(socket);
    await reply(
      socket,
      'helper.sources',
      {
        deviceId: 'd_pc',
        sources: [{ sourceId: 'test', kind: 'screen', label: 'Test pattern', hasAudio: false }],
      },
      list.id,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Test pattern' }));

    // Game (1080p60) stays the default; no preset cards, no cost per viewer.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByText(/per viewer/)).not.toBeInTheDocument();
    const resolution = screen.getByRole('combobox', { name: 'Resolution' });
    const fps = screen.getByRole('combobox', { name: 'Frame rate (FPS)' });
    expect(resolution).toHaveTextContent('1080p');
    expect(fps).toHaveTextContent('60');

    // The room does not offer native, so there is no 4K; 1080p lists 30, 60 and 120.
    await userEvent.click(fps);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['30', '60', '120']);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(resolution);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['1080p', '1440p']);
    await userEvent.click(screen.getByRole('option', { name: '1440p' }));
    expect(screen.getByRole('combobox', { name: 'Resolution' })).toHaveTextContent('1440p');
    expect(screen.getByRole('combobox', { name: 'Frame rate (FPS)' })).toHaveTextContent('60');

    await userEvent.click(screen.getByRole('combobox', { name: 'Frame rate (FPS)' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['60', '120']);
    await userEvent.click(screen.getByRole('option', { name: '120' }));
    expect(
      // No sound on this source: 13 − 3.5 − 1 leaves 8.5 Mb/s.
      screen.getByText(/The top layer gets about 8\.5 Mb\/s instead of 20 Mb\/s\./),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start streaming' }));
    expect(lastCommand(socket)).toMatchObject({
      type: 'helper.startStream',
      payload: { preset: 'max120' },
    });
  });
});
