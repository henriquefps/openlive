// SPDX-License-Identifier: AGPL-3.0-only
import type { StatsReportLike } from '@openlive/client';
import { describe, expect, it, vi } from 'vitest';
import { audioLevelsFromStats, StatsLevelHub } from '../src/voice/levels.ts';
import { PhoneVoiceOutput } from '../src/voice/output.ts';

const report = (items: object[]): StatsReportLike =>
  ({
    forEach: (callback: (value: unknown) => void) => items.forEach(callback),
  }) as StatsReportLike;

describe('audio levels from stats', () => {
  it('reads inbound audio and the microphone source by track id, ignores video and others', () => {
    const levels = audioLevelsFromStats(
      report([
        { type: 'inbound-rtp', kind: 'audio', trackIdentifier: 'ana', audioLevel: 0.2 },
        { type: 'inbound-rtp', kind: 'video', trackIdentifier: 'cam', audioLevel: 0.9 },
        { type: 'media-source', kind: 'audio', trackIdentifier: 'mic', audioLevel: 0.05 },
        { type: 'transport', trackIdentifier: 'x', audioLevel: 1 },
        { type: 'inbound-rtp', kind: 'audio', trackIdentifier: 'no-level' },
      ]),
    );
    expect([...levels]).toEqual([
      ['ana', 0.2],
      ['mic', 0.05],
    ]);
  });
});

describe('StatsLevelHub', () => {
  function setup() {
    let tick: () => void = () => undefined;
    const timers = {
      setInterval: vi.fn((cb: () => void) => ((tick = cb), 'h')),
      clearInterval: vi.fn(),
    };
    let level = 0.3;
    const source = {
      getStats: vi.fn(() =>
        Promise.resolve(
          report([
            { type: 'inbound-rtp', kind: 'audio', trackIdentifier: 'ana', audioLevel: level },
          ]),
        ),
      ),
    };
    const hub = new StatsLevelHub(source, timers, 200);
    return { hub, timers, source, tick: () => tick(), setLevel: (l: number) => (level = l) };
  }

  it("polls once for all readers and gives each its own track's level", async () => {
    const t = setup();
    const ana = t.hub.open('ana');
    const other = t.hub.open('bo');
    expect(t.timers.setInterval).toHaveBeenCalledTimes(1);
    expect(ana.read()).toBe(0);
    t.tick();
    await vi.waitFor(() => expect(ana.read()).toBe(0.3));
    expect(other.read()).toBe(0);
    expect(t.source.getStats).toHaveBeenCalledTimes(1);
  });

  it('stops polling when the last reader closes, and starts again for the next', () => {
    const t = setup();
    const a = t.hub.open('ana');
    const b = t.hub.open('bo');
    a.close();
    a.close();
    expect(t.timers.clearInterval).not.toHaveBeenCalled();
    b.close();
    expect(t.timers.clearInterval).toHaveBeenCalledWith('h');
    t.hub.open('ana');
    expect(t.timers.setInterval).toHaveBeenCalledTimes(2);
  });

  it('keeps the last levels when stats fail between two sessions', async () => {
    const t = setup();
    const ana = t.hub.open('ana');
    t.tick();
    await vi.waitFor(() => expect(ana.read()).toBe(0.3));
    t.source.getStats.mockRejectedValueOnce(new Error('closed'));
    t.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(ana.read()).toBe(0.3);
  });
});

describe('PhoneVoiceOutput', () => {
  function setup() {
    const volumes = new Map<string, number>();
    const output = new PhoneVoiceOutput<{
      enabled: boolean;
      stop(): void;
      addEventListener(): void;
      id: string;
    }>((track) => ({ setVolume: (v) => void volumes.set(track.id, v) }));
    const track = (id: string) => ({
      id,
      enabled: true,
      stop: () => undefined,
      addEventListener: () => undefined,
    });
    return { output, volumes, track };
  }

  it('plays each person at their volume, 0 to 2', () => {
    const t = setup();
    t.output.attach('ana', t.track('ana'), 1);
    t.output.attach('bo', t.track('bo'), 0.5);
    t.output.setVolume('bo', 1.5);
    expect([...t.volumes]).toEqual([
      ['ana', 1],
      ['bo', 1.5],
    ]);
  });

  it('deafen silences everyone and lifting it gives the volumes back', () => {
    const t = setup();
    t.output.attach('ana', t.track('ana'), 1.2);
    t.output.setDeafened(true);
    expect(t.volumes.get('ana')).toBe(0);
    t.output.setVolume('ana', 0.8); // changed while deafened: still silent
    expect(t.volumes.get('ana')).toBe(0);
    t.output.setDeafened(false);
    expect(t.volumes.get('ana')).toBe(0.8);
  });

  it('a track attached while deafened starts silent', () => {
    const t = setup();
    t.output.setDeafened(true);
    t.output.attach('ana', t.track('ana'), 1);
    expect(t.volumes.get('ana')).toBe(0);
  });

  it("cannot pick a sink: the route is the phone's", async () => {
    const t = setup();
    expect(t.output.canPickSink).toBe(false);
    await expect(t.output.setSink()).resolves.toBe(false);
  });
});
