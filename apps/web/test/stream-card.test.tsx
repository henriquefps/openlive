// SPDX-License-Identifier: AGPL-3.0-only
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamCard, type StreamCardProps } from '../src/components/StreamCard.tsx';
import i18n from '../src/i18n/index.ts';
import { INITIAL_STATE } from '../src/room/connection.ts';
import { streamCards } from '../src/routes/room/RoomStreams.tsx';

const plain = (text: string | null) => text?.replace(/[\u00a0\u202f]/g, ' ');

const stream: StreamCardProps = {
  name: 'Ana',
  source: 'Hades II',
  height: 1440,
  fps: 60,
  bitrateBps: 12_000_000,
  viewers: { used: 4, limit: 6 },
  status: 'live',
};

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('StreamCard', () => {
  it('shows the name, the mono meta line and the viewer slots', () => {
    render(<StreamCard {...stream} />);
    expect(screen.getByRole('heading', { name: 'Ana' })).toBeInTheDocument();
    expect(plain(screen.getByText(/^1440p60/).textContent)).toBe('1440p60 · 12 Mb/s');
    expect(screen.getByText('4/6').parentElement).toHaveClass('tabular-nums');
    expect(screen.getByText('4 of 6 viewer slots taken')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.queryByText('Full')).not.toBeInTheDocument();
  });

  it('marks a full stream with the warning tone', () => {
    render(<StreamCard {...stream} viewers={{ used: 6, limit: 6 }} />);
    expect(screen.getByText('Full')).toBeInTheDocument();
    expect(screen.getByText('6/6').parentElement).toHaveClass('text-warning');
  });

  it('translates the status and formats the bitrate per locale', async () => {
    await i18n.changeLanguage('pt-BR');
    render(<StreamCard {...stream} bitrateBps={4_500_000} status="paused" />);
    expect(screen.getByText('Pausado')).toBeInTheDocument();
    expect(plain(screen.getByText(/^1440p60/).textContent)).toBe('1440p60 · 4,5 Mb/s');
  });
});

describe('StreamCard in the room grid', () => {
  it('opens the watch view from a click anywhere on the card', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<StreamCard {...stream} onOpen={onOpen} selected />);
    const button = screen.getByRole('button', { name: "Watch Ana's stream" });
    expect(button).toHaveAttribute('aria-current', 'true');
    await user.click(button);
    expect(onOpen).toHaveBeenCalled();
  });

  it('maps the room state to cards: names, preset, paused and live viewer counts', () => {
    const cards = streamCards(
      {
        ...INITIAL_STATE,
        members: [{ userId: 'u_ana', displayName: 'Ana', role: 'owner', canStream: true }],
        streams: [
          {
            streamId: 'st_2',
            userId: 'u_gone',
            deviceId: 'd_2',
            source: { kind: 'screen', label: 'Screen 1' },
            preset: 'text',
            hasAudio: false,
            paused: true,
            pauseReason: 'source_hidden',
            startedAt: 20,
            viewerLimit: 4,
            viewerCount: 1,
          },
          {
            streamId: 'st_1',
            userId: 'u_ana',
            deviceId: 'd_1',
            source: { kind: 'window', label: 'Hades II' },
            preset: 'max',
            hasAudio: true,
            paused: false,
            startedAt: 10,
            viewerLimit: 6,
            viewerCount: 2,
          },
        ],
        viewers: {
          st_1: { streamId: 'st_1', viewerUserIds: [], used: 6, limit: 6, queueLength: 1 },
        },
      },
      'Someone',
    );
    expect(cards.map((c) => [c.id, c.name, c.height, c.fps, c.status, c.viewers])).toEqual([
      ['st_1', 'Ana', 1440, 60, 'live', { used: 6, limit: 6 }],
      ['st_2', 'Someone', 1080, 30, 'paused', { used: 1, limit: 4 }],
    ]);
  });

  it('shows the layer the helper encodes, not the preset table (protocol 1.19)', () => {
    const [card] = streamCards(
      {
        ...INITIAL_STATE,
        streams: [
          {
            streamId: 'st_1',
            userId: 'u_ana',
            deviceId: 'd_1',
            source: { kind: 'screen', label: 'DP-2' },
            preset: 'native',
            hasAudio: true,
            paused: false,
            startedAt: 10,
            viewerLimit: 6,
            viewerCount: 0,
            // A 3440x1440 monitor: native is the monitor's size, not 2160p.
            layers: [
              { rid: 'f', width: 3440, height: 1440, fps: 60, kbps: 24872 },
              { rid: 'h', width: 1728, height: 720, fps: 60, kbps: 3500 },
              { rid: 'q', width: 1152, height: 480, fps: 30, kbps: 1000 },
            ],
          },
        ],
      },
      'Someone',
    );
    expect([card?.height, card?.fps, card?.bitrateBps]).toEqual([1440, 60, 24_872_000]);
  });

  it('shows the thumbnail over the black frame, and the placeholder when it fails', () => {
    const { container } = render(
      <StreamCard {...stream} thumbnailUrl="/api/streams/st_1/thumbnail?v=5" />,
    );
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', '/api/streams/st_1/thumbnail?v=5');
    expect(img?.parentElement).toHaveClass('bg-player');
    if (img) fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('No preview')).toBeInTheDocument();
  });

  it('marks a stream capped by economy mode', () => {
    render(<StreamCard {...stream} economy />);
    expect(screen.getByText('Economy')).toBeInTheDocument();
  });

  it('versions the thumbnail URL with thumbnailAt and flags economy mode', () => {
    const [card] = streamCards(
      {
        ...INITIAL_STATE,
        streams: [
          {
            streamId: 'st_1',
            userId: 'u_ana',
            deviceId: 'd_1',
            source: { kind: 'screen', label: 'Screen 1' },
            preset: 'game',
            hasAudio: false,
            paused: false,
            startedAt: 10,
            viewerLimit: 6,
            viewerCount: 0,
            thumbnailAt: 1234,
            qualityCap: { maxHeight: 1080, maxBitrateKbps: 8000 },
          },
        ],
      },
      'Someone',
    );
    expect(card?.thumbnailUrl).toBe('/api/streams/st_1/thumbnail?v=1234');
    expect(card?.economy).toBe(true);
  });
});
