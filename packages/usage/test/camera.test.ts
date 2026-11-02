// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  cameraHourGB,
  monthlyScenario,
  NO_OVERHEADS,
  overheads,
  viewerStreamGB,
} from '../src/calculator.js';
import { CAMERA_LAYERS, cameraLayerKbps, DEFAULT_MAX_CAMERAS } from '../src/presets.js';

// Cameras in the voice channel: the table's numbers come out of
// the same formula as streams.

describe('camera egress per hour (overheads off)', () => {
  it('6 cameras among 6 people on the strip layer ≈ 2 GB an hour', () => {
    const gb = cameraHourGB({ cameras: 6, people: 6, cameraKbps: 150 }, NO_OVERHEADS);
    // 6 × 5 pulls × 150 kbps = 4.5 Mbps.
    expect(gb).toBeCloseTo(2.025, 9);
  });

  it('6 cameras, everyone enlarging (360p) ≈ 6.8 GB an hour', () => {
    const gb = cameraHourGB({ cameras: 6, people: 6, cameraKbps: 500 }, NO_OVERHEADS);
    expect(gb).toBeCloseTo(6.75, 9);
  });

  it('nobody else in voice pulls nothing', () => {
    expect(cameraHourGB({ cameras: 1, people: 1, cameraKbps: 500 }, overheads(true))).toBe(0);
  });

  it('pays one join per pull with the overheads on', () => {
    const o = overheads(true);
    const gb = cameraHourGB({ cameras: 2, people: 3, cameraKbps: 150 }, o);
    const pulls = 4;
    expect(gb).toBeCloseTo(
      pulls * viewerStreamGB(0.15, 3600, o) + pulls * ((o.joinMB * (0.15 / 8)) / 1000),
      9,
    );
  });
});

describe('camera layers', () => {
  it('360p ~500 kbps and 180p ~150 kbps, default 6 cameras', () => {
    expect(CAMERA_LAYERS.h).toMatchObject({ height: 360, kbps: 500 });
    expect(CAMERA_LAYERS.l).toMatchObject({ height: 180, kbps: 150 });
    expect(DEFAULT_MAX_CAMERAS).toBe(6);
  });

  it('charges a pull at its layer, the high one when unknown', () => {
    expect(cameraLayerKbps('l')).toBe(150);
    expect(cameraLayerKbps('h')).toBe(500);
    expect(cameraLayerKbps(null)).toBe(500);
  });
});

describe('monthly scenario with cameras', () => {
  const base = {
    streamsPerDay: 1,
    hoursPerStream: 2,
    viewersPerStream: 4,
    days: 20,
    bitrateMbps: 8,
  };

  it('adds the cameras on the strip layer to the stream egress', () => {
    const without = monthlyScenario(base, NO_OVERHEADS).totalGB;
    const withCameras = monthlyScenario({ ...base, cameras: 5 }, NO_OVERHEADS).totalGB;
    // 5 cameras, 5 people: 20 pulls at 150 kbps for 40 hours.
    expect(withCameras - without).toBeCloseTo(
      40 * cameraHourGB({ cameras: 5, people: 5, cameraKbps: 150 }, NO_OVERHEADS),
      9,
    );
  });

  it('is unchanged without cameras', () => {
    expect(monthlyScenario({ ...base, cameras: 0 }, NO_OVERHEADS)).toEqual(
      monthlyScenario(base, NO_OVERHEADS),
    );
  });
});
