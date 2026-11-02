// SPDX-License-Identifier: AGPL-3.0-only
import type { StreamInfo } from '@openlive/protocol';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/i18n/index.ts';
import Player, { PING_SHOW_MS, type PlayerProps } from '../src/player/Player.tsx';
import type { PlayerSource } from '../src/player/source.ts';
import { pointerStyle } from '../src/pointer/style.ts';

// Click mode in the player (docs/PROTOCOL.md 7.9): the pointer button, the frame click
// normalized past the black bars, the local marker, keyboard use and leaving.

const STREAM: StreamInfo = {
  streamId: 'st_1',
  userId: 'u_ana',
  deviceId: 'd_1',
  source: { kind: 'screen', label: 'Screen' },
  preset: 'game',
  hasAudio: true,
  paused: false,
  startedAt: 0,
  viewerLimit: 6,
  viewerCount: 1,
  pingOverlay: true,
  pings: true,
};

const SOURCE: PlayerSource = {
  state: { kind: 'live' },
  layers: [{ rid: 'f', height: 1080, fps: 60 }],
  layer: 'f',
  setLayer: vi.fn(),
  getStats: () => Promise.resolve(new Map()),
  retry: vi.fn(),
  subscribe: () => () => undefined,
};

const MEDIA = {
  getVideoTracks: () => [],
  getAudioTracks: () => [],
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
} as unknown as MediaStream;

function props(patch: Partial<PlayerProps> = {}): PlayerProps {
  return {
    stream: MEDIA,
    source: SOURCE,
    room: { status: 'open', ended: null },
    streamInfo: STREAM,
    endedReason: null,
    access: { kind: 'granted', slotId: 'sl_1', expiresAt: 0, leaseMs: 30_000 },
    streamer: { userId: 'u_ana', name: 'Ana' },
    hasAudio: true,
    viewers: null,
    theater: false,
    onTheaterChange: vi.fn(),
    onJoinQueue: vi.fn(),
    onLeaveQueue: vi.fn(),
    onAccept: vi.fn(),
    onRetry: vi.fn(),
    ...patch,
  };
}

/** A 1600×900 player showing a 4:3 1024×768 frame: 200 px black bars left and right. */
function renderLive(patch: Partial<PlayerProps> = {}) {
  const view = render(<Player {...props(patch)} />);
  const video = view.container.querySelector('video');
  if (!video) throw new Error('no video');
  Object.defineProperty(video, 'videoWidth', { value: 1024, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 768, configurable: true });
  video.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900 }) as DOMRect;
  act(() => void fireEvent(video, new Event('playing')));
  return {
    ...view,
    rerenderWith: (p: Partial<PlayerProps>) =>
      view.rerender(<Player {...props({ ...patch, ...p })} />),
  };
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  pointerStyle.update({ color: 'olive', shape: 'ring' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Player click mode', () => {
  it('shows no pointer button while pings are not allowed', () => {
    renderLive({ pointer: null });
    expect(screen.queryByTestId('player-click-mode')).not.toBeInTheDocument();
  });

  it('enters click mode, sends a normalized click and shows it at once', async () => {
    const onPing = vi.fn(() => true);
    renderLive({ pointer: { onPing } });
    const button = screen.getByRole('button', { name: 'Click on the screen (P)' });
    await userEvent.click(button);
    expect(screen.getByRole('button', { name: 'Stop clicking (P)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('player-click-banner')).toHaveTextContent(
      "Your clicks show on Ana's screen",
    );
    const layer = screen.getByTestId('player-click-layer');
    expect(layer).toHaveClass('cursor-crosshair');
    expect(layer).toHaveFocus();

    // The middle of the frame, and a quarter in past the 200 px bar.
    fireEvent.click(layer, { clientX: 800, clientY: 450 });
    fireEvent.click(layer, { clientX: 500, clientY: 225 });
    expect(onPing).toHaveBeenNthCalledWith(1, 0.5, 0.5, { color: 'olive', shape: 'ring' });
    expect(onPing).toHaveBeenNthCalledWith(2, 0.25, 0.25, { color: 'olive', shape: 'ring' });
    const marks = document.querySelectorAll('[data-slot="ping-indicator"]');
    expect(marks).toHaveLength(2);
    expect((marks[0] as HTMLElement).style.left).toBe('50%');
    expect((marks[1] as HTMLElement).style.left).toBe('31.25%');
    expect((marks[1] as HTMLElement).style.top).toBe('25%');
  });

  it('ignores clicks on the black bars', async () => {
    const onPing = vi.fn(() => true);
    renderLive({ pointer: { onPing } });
    await userEvent.click(screen.getByTestId('player-click-mode'));
    fireEvent.click(screen.getByTestId('player-click-layer'), { clientX: 100, clientY: 450 });
    fireEvent.click(screen.getByTestId('player-click-layer'), { clientX: 1550, clientY: 450 });
    expect(onPing).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="ping-indicator"]')).toBeNull();
  });

  it('removes the local marker after about two seconds, and shows none when held back', () => {
    vi.useFakeTimers();
    const onPing = vi.fn(() => true);
    renderLive({ pointer: { onPing } });
    fireEvent.click(screen.getByTestId('player-click-mode'));
    const layer = screen.getByTestId('player-click-layer');
    fireEvent.click(layer, { clientX: 800, clientY: 450 });
    expect(document.querySelectorAll('[data-slot="ping-indicator"]')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(PING_SHOW_MS));
    expect(document.querySelectorAll('[data-slot="ping-indicator"]')).toHaveLength(0);

    onPing.mockReturnValue(false);
    fireEvent.click(layer, { clientX: 800, clientY: 450 });
    expect(document.querySelectorAll('[data-slot="ping-indicator"]')).toHaveLength(0);
  });

  it('works from the keyboard: P enters, arrows move, Enter clicks, Esc leaves', async () => {
    const user = userEvent.setup();
    const onPing = vi.fn(() => true);
    renderLive({ pointer: { onPing } });
    screen.getByRole('region', { name: "Ana's stream" }).focus();
    await user.keyboard('p');
    const layer = screen.getByTestId('player-click-layer');
    expect(layer).toHaveFocus();
    // Arrows move the target, not the volume.
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowUp}');
    expect(screen.getByTestId('player-key-target')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveAttribute('aria-valuenow', '80');
    await user.keyboard('{Enter}');
    expect(onPing).toHaveBeenCalledOnce();
    const [x, y] = onPing.mock.calls[0] as unknown as [number, number];
    expect(x).toBeCloseTo(0.6);
    expect(y).toBeCloseTo(0.45);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('player-click-layer')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Click on the screen (P)' })).toHaveFocus();
  });

  it('leaves click mode when pings turn off or the stream pauses', async () => {
    const pointer = { onPing: vi.fn(() => true) };
    const view = renderLive({ pointer });
    await userEvent.click(screen.getByTestId('player-click-mode'));
    expect(screen.getByTestId('player-click-layer')).toBeInTheDocument();
    view.rerenderWith({ pointer: null });
    expect(screen.queryByTestId('player-click-layer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('player-click-banner')).not.toBeInTheDocument();
    // Pings back on: the mode does not come back by itself.
    view.rerenderWith({ pointer });
    expect(screen.queryByTestId('player-click-layer')).not.toBeInTheDocument();
  });

  it('keeps the normal player controls working outside click mode', async () => {
    const onPing = vi.fn(() => true);
    const onTheaterChange = vi.fn();
    renderLive({ pointer: { onPing }, onTheaterChange });
    await userEvent.click(screen.getByRole('button', { name: 'Theater mode (T)' }));
    expect(onTheaterChange).toHaveBeenCalledWith(true);
    const video = document.querySelector('video');
    if (video) fireEvent.click(video, { clientX: 800, clientY: 450 });
    expect(onPing).not.toHaveBeenCalled();
  });
});
