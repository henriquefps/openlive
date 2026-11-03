// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../src/i18n/index.ts';
import { refreshHzFrom, screenLimit } from '../src/player/display.ts';
import type { StatsSample } from '@openlive/client';
import { StatsOverlay } from '../src/player/StatsOverlay.tsx';

// Stats for nerds and the viewer's screen: received fps, the screen's refresh
// rate and the frames it shows, and "your screen is 60 Hz" when it caps a 120 fps stream.

function sample(patch: Partial<StatsSample> = {}): StatsSample {
  return {
    at: 1000,
    width: 2560,
    height: 1440,
    fps: 119.6,
    bitrateBps: 19_000_000,
    loss: 0,
    newFreezes: 0,
    newFramesDropped: 4,
    newFramesDecoded: 120,
    jitterBufferMs: 10,
    rttMs: 20,
    codec: 'H264',
    decodeMs: 2,
    framesDecoded: 12_000,
    packetsLost: 0,
    freezeCount: 0,
    counters: {
      at: 1000,
      framesDecoded: 12_000,
      bytesReceived: 0,
      packetsReceived: 0,
      packetsLost: 0,
      freezeCount: 0,
      totalDecodeTime: 0,
      framesDropped: 4,
    },
    ...patch,
  };
}

const LAYER = { rid: 'f' as const, height: 1440, fps: 120 };

const overlay = (s: StatsSample, screenHz: number | null, presentedFps: number | null) =>
  render(
    <StatsOverlay
      sample={s}
      layer={LAYER}
      quality="auto"
      ttffMs={null}
      display={{ screenHz, presentedFps }}
      onClose={() => undefined}
    />,
  );

/** The value next to a label in the overlay's list. */
const row = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;

describe('stats for nerds: the screen', () => {
  it('shows received fps, the screen and the frames it shows, and says a 60 Hz screen caps it', () => {
    overlay(sample(), 59.94, 60.1);
    expect(row('Frame rate received')).toHaveTextContent('119.6');
    expect(row('Screen')).toHaveTextContent('60 Hz · 60 fps shown');
    expect(row('Dropped frames')).toHaveTextContent('4 a second');
    expect(
      screen.getByText('Your screen is 60 Hz: you are seeing 60 fps of a 120 fps stream.'),
    ).toBeInTheDocument();
  });

  it('says nothing about the screen when it keeps up', () => {
    overlay(sample(), 143.9, 119.8);
    expect(row('Screen')).toHaveTextContent('144 Hz · 120 fps shown');
    expect(screen.queryByText(/Your screen is/)).not.toBeInTheDocument();
  });

  it('shows a dash before the screen is measured', () => {
    overlay(sample({ fps: 60 }), null, null);
    expect(row('Screen')).toHaveTextContent('–');
    expect(screen.queryByText(/Your screen is/)).not.toBeInTheDocument();
  });
});

describe('refresh rate from requestAnimationFrame intervals', () => {
  it('takes the median, ignoring a skipped or slow frame', () => {
    const at60 = Array.from({ length: 60 }, () => 1000 / 60);
    expect(refreshHzFrom([...at60, 33.4, 50, 250])).toBeCloseTo(60);
    expect(refreshHzFrom(Array.from({ length: 60 }, () => 1000 / 175))).toBeCloseTo(175);
    expect(refreshHzFrom([16.7, 16.7])).toBeNull();
  });

  it('names the screen only when the stream is clearly faster', () => {
    expect(screenLimit(120, 59.94)).toBe(60);
    expect(screenLimit(62, 60)).toBeNull();
    expect(screenLimit(120, 144)).toBeNull();
    expect(screenLimit(null, 60)).toBeNull();
  });
});
