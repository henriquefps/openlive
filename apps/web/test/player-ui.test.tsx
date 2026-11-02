// SPDX-License-Identifier: AGPL-3.0-only
import type { StreamInfo } from '@openlive/protocol';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../src/i18n/index.ts';
import Player, { type PlayerProps } from '../src/player/Player.tsx';
import type { PlayerSource, SourceState } from '../src/player/source.ts';
import { loadVolume } from '../src/player/volume.ts';

const STREAM: StreamInfo = {
  streamId: 'st_1',
  userId: 'u_ana',
  deviceId: 'd_1',
  source: { kind: 'window', label: 'Hades II' },
  preset: 'game',
  hasAudio: true,
  paused: false,
  startedAt: 0,
  viewerLimit: 6,
  viewerCount: 6,
};

function fakeSource(state: SourceState = { kind: 'live' }): PlayerSource {
  return {
    state,
    layers: [
      { rid: 'f', height: 1080, fps: 60 },
      { rid: 'h', height: 720, fps: 60 },
      { rid: 'q', height: 480, fps: 30 },
    ],
    layer: 'f',
    setLayer: vi.fn(),
    getStats: () => Promise.resolve(new Map()),
    retry: vi.fn(),
    subscribe: () => () => undefined,
  };
}

// jsdom has no MediaStream: the player only reads its tracks and listens for new ones.
const MEDIA = {
  getVideoTracks: () => [],
  getAudioTracks: () => [],
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
} as unknown as MediaStream;

/** A stream whose tracks arrive after play(), as rtc/source.ts adds them. */
class LateTracksStream extends EventTarget {
  audio: object[] = [];
  getVideoTracks = () => [];
  getAudioTracks = () => this.audio;
}

function props(patch: Partial<PlayerProps> = {}): PlayerProps {
  return {
    stream: MEDIA,
    source: fakeSource(),
    room: { status: 'open', ended: null },
    streamInfo: STREAM,
    endedReason: null,
    access: { kind: 'granted', slotId: 'sl_1', expiresAt: 0, leaseMs: 30_000 },
    streamer: { userId: 'u_ana', name: 'Ana' },
    hasAudio: true,
    viewers: { used: 6, limit: 6, queueLength: 2 },
    theater: false,
    onTheaterChange: vi.fn(),
    onJoinQueue: vi.fn(),
    onLeaveQueue: vi.fn(),
    onAccept: vi.fn(),
    onRetry: vi.fn(),
    ...patch,
  };
}

/** Renders and lets the first frame "arrive" (jsdom has no requestVideoFrameCallback). */
function renderLive(patch: Partial<PlayerProps> = {}) {
  const view = render(<Player {...props(patch)} />);
  const video = view.container.querySelector('video');
  if (video) act(() => void fireEvent(video, new Event('playing')));
  return view;
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await i18n.changeLanguage('en');
});

describe('Player controls', () => {
  it('plays live with volume, quality, stats, theater and fullscreen controls', async () => {
    const user = userEvent.setup();
    const onTheaterChange = vi.fn();
    renderLive({ onTheaterChange });
    expect(screen.getByRole('region', { name: "Ana's stream" })).toHaveAttribute(
      'data-screen',
      'live',
    );
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mute (M)' })).toBeEnabled();
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveAttribute('aria-valuenow', '80');

    await user.click(screen.getByRole('button', { name: 'Theater mode (T)' }));
    expect(onTheaterChange).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole('button', { name: 'Stats for nerds (I)' }));
    expect(screen.getByRole('heading', { name: 'Stats for nerds' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Quality' }));
    expect(screen.getByRole('menuitemradio', { name: 'Automatic (1080p60)' })).toBeChecked();
    expect(screen.getByRole('menuitemradio', { name: '720p60' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: '480p30' })).toBeInTheDocument();
  });

  it('a fixed quality asks the source for that layer', async () => {
    const user = userEvent.setup();
    const source = fakeSource();
    renderLive({ source });
    await user.click(screen.getByRole('button', { name: 'Quality' }));
    await user.click(screen.getByRole('menuitemradio', { name: '480p30' }));
    expect(source.setLayer).toHaveBeenCalledWith('q');
  });

  it('M mutes, arrows change the volume, and both are remembered for this streamer', () => {
    renderLive();
    const region = screen.getByRole('region', { name: "Ana's stream" });
    fireEvent.keyDown(region, { key: 'm' });
    expect(screen.getByRole('button', { name: 'Unmute (M)' })).toBeInTheDocument();
    expect(loadVolume('u_ana')).toEqual({ volume: 0.8, muted: true });
    fireEvent.keyDown(region, { key: 'ArrowUp' });
    expect(loadVolume('u_ana')).toEqual({ volume: 0.85, muted: false });
    fireEvent.keyDown(region, { key: 'ArrowDown' });
    fireEvent.keyDown(region, { key: 'ArrowDown' });
    expect(loadVolume('u_ana')).toEqual({ volume: 0.75, muted: false });
    expect(screen.getByText('Volume 75%')).toBeInTheDocument();
    // Another streamer starts from the default.
    expect(loadVolume('u_bruno').volume).toBe(0.8);
  });

  it('starts from the volume remembered for the streamer', () => {
    localStorage.setItem('openlive.volume.u_ana', JSON.stringify({ volume: 0.3, muted: false }));
    renderLive();
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveAttribute('aria-valuenow', '30');
  });

  it('says when the stream has no audio instead of a broken volume control', () => {
    renderLive({ hasAudio: false });
    expect(screen.getByRole('button', { name: 'No audio' })).toBeDisabled();
    expect(screen.getByText('No audio')).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('offers "tap to unmute" when the browser refuses autoplay with sound', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(new DOMException('no gesture', 'NotAllowedError'))
      .mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderLive();
    const tap = await screen.findByRole('button', { name: 'Tap to unmute' });
    expect(screen.getByRole('button', { name: 'Unmute (M)' })).toBeInTheDocument();
    await user.click(tap);
    expect(screen.queryByRole('button', { name: 'Tap to unmute' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mute (M)' })).toBeInTheDocument();
  });

  it('falls back to muted when WebKit pauses the video as its audio track arrives', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const stream = new LateTracksStream();
    const { container } = renderLive({ stream: stream as unknown as MediaStream });
    const video = container.querySelector('video');
    if (!video) throw new Error('no video');
    // play() on the still empty stream is allowed: no audio track yet, so it is not "sound allowed".
    await act(async () => Promise.resolve());
    expect(video.muted).toBe(false);
    expect(screen.queryByRole('button', { name: 'Tap to unmute' })).not.toBeInTheDocument();
    const calls = play.mock.calls.length;

    // The tracks arrive; WebKit (iOS) pauses the unmuted element instead of rejecting anything.
    stream.audio = [{}];
    await act(async () => {
      stream.dispatchEvent(new Event('addtrack'));
      video.dispatchEvent(new Event('pause'));
      await Promise.resolve();
    });
    expect(video.muted).toBe(true);
    expect(play.mock.calls.length).toBeGreaterThan(calls + 1);
    expect(await screen.findByRole('button', { name: 'Tap to unmute' })).toBeInTheDocument();

    // A tap unmutes for good: a later pause (the viewer's, in picture-in-picture) is respected.
    await userEvent.click(screen.getByRole('button', { name: 'Tap to unmute' }));
    expect(video.muted).toBe(false);
    act(() => void video.dispatchEvent(new Event('pause')));
    expect(video.muted).toBe(false);
    expect(screen.queryByRole('button', { name: 'Tap to unmute' })).not.toBeInTheDocument();
  });

  it('keeps sound when the browser allowed it with the audio track present', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const stream = new LateTracksStream();
    stream.audio = [{}];
    const { container } = renderLive({ stream: stream as unknown as MediaStream });
    const video = container.querySelector('video');
    if (!video) throw new Error('no video');
    await act(async () => Promise.resolve());
    act(() => void video.dispatchEvent(new Event('pause')));
    expect(video.muted).toBe(false);
    expect(screen.queryByRole('button', { name: 'Tap to unmute' })).not.toBeInTheDocument();
  });

  it('shows the connecting screen until the first frame', () => {
    render(<Player {...props()} />);
    expect(screen.getByRole('region', { name: "Ana's stream" })).toHaveAttribute(
      'data-screen',
      'connecting',
    );
    expect(screen.getByRole('heading', { name: 'Connecting…' })).toBeInTheDocument();
  });
});

describe('Player state screens', () => {
  it('a full stream offers the queue, then shows the position', async () => {
    const user = userEvent.setup();
    const onJoinQueue = vi.fn();
    const { rerender } = render(
      <Player {...props({ access: { kind: 'full', queue: null }, source: null, onJoinQueue })} />,
    );
    expect(screen.getByRole('heading', { name: 'This stream is full' })).toBeInTheDocument();
    expect(screen.getByText('6/6 slots taken')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Join the queue' }));
    expect(onJoinQueue).toHaveBeenCalled();

    const onLeaveQueue = vi.fn();
    rerender(
      <Player
        {...props({
          access: { kind: 'full', queue: { position: 2, length: 3 } },
          source: null,
          onLeaveQueue,
        })}
      />,
    );
    expect(screen.getByText('You are number 2 of 3 in line')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Leave the queue' }));
    expect(onLeaveQueue).toHaveBeenCalled();
  });

  it('a queue offer counts down its 30 s and can be taken or declined', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    const onLeaveQueue = vi.fn();
    render(
      <Player
        {...props({
          access: { kind: 'offer', offerId: 'of_1', expiresAt: Date.now() + 25_000 },
          source: null,
          onAccept,
          onLeaveQueue,
        })}
      />,
    );
    expect(screen.getByText('A slot is free for you')).toBeInTheDocument();
    expect(screen.getByText(/^2[45] s left$/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch now' }));
    expect(onAccept).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onLeaveQueue).toHaveBeenCalled();
  });

  it('explains every other state in the viewer language', async () => {
    await i18n.changeLanguage('pt-BR');
    const { rerender } = render(
      <Player
        {...props({ streamInfo: { ...STREAM, paused: true, pauseReason: 'privacy_curtain' } })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Cortina de privacidade' })).toBeInTheDocument();
    rerender(<Player {...props({ streamInfo: null, endedReason: 'helper_disconnected' })} />);
    expect(
      screen.getByRole('heading', { name: 'O helper de Ana ficou offline' }),
    ).toBeInTheDocument();
    rerender(
      <Player
        {...props({ room: { status: 'ended', ended: { kind: 'closed', reason: 'expired' } } })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Esta sala expirou' })).toBeInTheDocument();
  });

  it('retry on the reconnecting screen asks the source again', async () => {
    const user = userEvent.setup();
    const source = fakeSource({ kind: 'failed', reason: 'network' });
    render(<Player {...props({ source })} />);
    await user.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(source.retry).toHaveBeenCalled();
  });
});
