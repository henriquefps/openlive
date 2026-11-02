// SPDX-License-Identifier: AGPL-3.0-only
import type { RoomSettings } from '@openlive/protocol';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoLiveArea } from '../src/golive/GoLive.tsx';
import type { HubConnection } from '../src/hub/connection.ts';
import { HubContext } from '../src/hub/use-hub.ts';
import type { ActiveVoice } from '../src/voice/use-voice-session.ts';
import { VoiceEchoWarning } from '../src/voice/VoiceEchoWarning.tsx';
import { connectedHub } from './hub-fakes.ts';

// "People in voice will hear themselves in your stream" in the Go live panel, the live
// controls and the voice bar: shown in voice, with voice not in the helper's voice sink, while the
// stream takes this browser's audio.

const voice = vi.hoisted(() => ({
  active: null as { voice: { phase: string; voiceSinkId: string | null } } | null,
}));
vi.mock('../src/voice/use-voice-session.ts', async (original) => ({
  ...(await original<typeof import('../src/voice/use-voice-session.ts')>()),
  useActiveVoice: () => voice.active as ActiveVoice | null,
}));

const CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const TITLE = 'People in voice will hear themselves in your stream';

const SETTINGS: RoomSettings = {
  maxStreams: 4,
  maxViewersPerStream: 6,
  maxBitrateKbps: 13000,
  allowedPresets: ['text', 'game', 'max'],
};

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(CHROME);
  voice.active = { voice: { phase: 'joined', voiceSinkId: null } };
});
afterEach(() => vi.restoreAllMocks());

async function renderArea(hub: HubConnection) {
  const rootRoute = createRootRoute({
    component: () => (
      <HubContext value={hub}>
        <GoLiveArea roomId="rm_1" settings={SETTINGS} canStream />
      </HubContext>
    ),
  });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() });
  render(<RouterProvider router={router} />);
  return screen.findByRole('button', { name: 'Go live' });
}

function live(socket: ReturnType<typeof connectedHub>['socket'], app?: object) {
  act(() =>
    socket.receive('helper.status', {
      deviceId: 'd_pc',
      state: 'live',
      stream: {
        roomId: 'rm_1',
        streamId: 'st_1',
        sourceId: 'portal:window',
        preset: 'game',
        ...(app ? { audioApp: app } : {}),
      },
    }),
  );
}

describe('the echo warning in Go live', () => {
  it('warns before the start when the window to share is this browser, with its audio', async () => {
    const { hub, socket } = connectedHub();
    await userEvent.click(await renderArea(hub));
    const list = socket.requests.at(-1);
    await act(async () =>
      socket.receive(
        'helper.sources',
        {
          deviceId: 'd_pc',
          sources: [
            {
              sourceId: 'w_1',
              kind: 'window',
              label: 'YouTube',
              appName: 'google-chrome',
              hasAudio: true,
            },
          ],
        },
        list?.id,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /YouTube/ }));
    // A window shares its own audio by default.
    const warning = screen.getByTestId('voice-echo-warning');
    expect(warning).toHaveTextContent(TITLE);
    expect(warning).toHaveTextContent(
      "The stream captures this browser's audio. Use another browser for the window you share, or share without audio.",
    );
  });

  it('warns while live when the helper captures this browser and voice is not in the sink', async () => {
    const { hub, socket } = connectedHub();
    await renderArea(hub);
    live(socket, { name: 'google-chrome', binary: 'chrome', browser: 'chromium' });
    const controls = screen.getByTestId('golive-live');
    expect(within(controls).getByTestId('voice-echo-warning')).toHaveTextContent(TITLE);
  });

  it('does not warn once voice plays into the voice sink', async () => {
    voice.active = { voice: { phase: 'joined', voiceSinkId: 'sink-1' } };
    const { hub, socket } = connectedHub();
    await renderArea(hub);
    live(socket, { name: 'google-chrome', browser: 'chromium' });
    expect(screen.getByTestId('golive-live')).toBeInTheDocument();
    expect(screen.queryByTestId('voice-echo-warning')).not.toBeInTheDocument();
  });

  it('does not warn out of voice, for another browser, or without app audio', async () => {
    const { hub, socket } = connectedHub();
    await renderArea(hub);
    live(socket, { name: 'brave-browser', binary: 'brave', browser: 'chromium' });
    expect(screen.queryByTestId('voice-echo-warning')).not.toBeInTheDocument();
    live(socket, { name: 'firefox', browser: 'firefox' });
    expect(screen.queryByTestId('voice-echo-warning')).not.toBeInTheDocument();
    live(socket);
    expect(screen.queryByTestId('voice-echo-warning')).not.toBeInTheDocument();
    voice.active = null;
    live(socket, { name: 'google-chrome', browser: 'chromium' });
    expect(screen.queryByTestId('voice-echo-warning')).not.toBeInTheDocument();
  });
});

describe('the echo warning in the voice bar', () => {
  it('fits one icon with the whole message for screen readers and the tooltip', () => {
    render(<VoiceEchoWarning compact captured={[{ name: 'chromium', browser: 'chromium' }]} />);
    const warning = screen.getByRole('alert');
    expect(warning).toHaveAttribute('title', expect.stringContaining(TITLE));
    expect(warning).toHaveTextContent(TITLE);
  });
});
