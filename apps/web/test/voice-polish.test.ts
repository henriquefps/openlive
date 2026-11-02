// SPDX-License-Identifier: AGPL-3.0-only
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { isIos, markTipSeen, tipSeen, useTip } from '../src/lib/tips.ts';
import {
  dbToGain,
  DEFAULT_DUCKING,
  DuckEnvelope,
  loadDucking,
  saveDucking,
  StreamDucking,
} from '../src/voice/ducking.ts';
import { outputKind, outputLabel, warnBoost } from '../src/voice/headphones.ts';

// The voice polish: the ducking envelope, the headphones
// guess behind the boost warning, and the one-time tips.

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('DuckEnvelope', () => {
  it('−12 dB is about a quarter of the volume', () => {
    expect(dbToGain(-12)).toBeCloseTo(0.251, 3);
    expect(dbToGain(0)).toBe(1);
  });

  it('ramps down over the attack and back over the release, in dB', () => {
    const e = new DuckEnvelope(100, 500);
    expect(e.db(0)).toBe(0);
    e.target(true, 12, 0);
    expect(e.db(50)).toBeCloseTo(-6);
    expect(e.db(100)).toBe(-12);
    expect(e.settled(100)).toBe(true);
    e.target(false, 12, 1000);
    expect(e.db(1250)).toBeCloseTo(-6);
    expect(e.db(1500)).toBe(0);
  });

  it('a change of mind halfway takes its share of the time, from where it is', () => {
    const e = new DuckEnvelope(100, 500);
    e.target(true, 12, 0);
    e.target(false, 12, 50);
    // From -6 dB back to 0 in half the release.
    expect(e.db(50)).toBeCloseTo(-6);
    expect(e.db(175)).toBeCloseTo(-3);
    expect(e.db(300)).toBe(0);
  });

  it('the same target again does not restart the ramp', () => {
    const e = new DuckEnvelope(100, 500);
    e.target(true, 12, 0);
    e.target(true, 12, 90);
    expect(e.db(100)).toBe(-12);
  });
});

describe('StreamDucking', () => {
  it('ducks while someone speaks and restores, telling the player on the way', () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const d = new StreamDucking(() => now, memory);
      const seen: number[] = [];
      d.subscribe(() => seen.push(d.gain()));
      d.setSpeaking(true);
      for (let i = 0; i < 10; i++) {
        now += 25;
        vi.advanceTimersByTime(25);
      }
      expect(d.gain()).toBeCloseTo(dbToGain(-12));
      expect(seen.length).toBeGreaterThan(2);
      // Monotonic down: smooth, no jumps back.
      expect([...seen].sort((a, b) => b - a)).toEqual(seen);
      d.setSpeaking(false);
      for (let i = 0; i < 40; i++) {
        now += 25;
        vi.advanceTimersByTime(25);
      }
      expect(d.gain()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turned off: the stream keeps its volume; the amount is remembered', () => {
    const store = memory();
    const d = new StreamDucking(
      () => 0,
      () => store,
    );
    d.setPrefs({ enabled: false });
    d.setSpeaking(true);
    expect(d.gain()).toBe(1);
    d.setPrefs({ enabled: true, amountDb: 18 });
    expect(loadDucking(store)).toEqual({ enabled: true, amountDb: 18 });
  });

  it('prefs default to on at −12 dB, and refuse odd amounts', () => {
    expect(DEFAULT_DUCKING).toEqual({ enabled: true, amountDb: 12 });
    const store = memory();
    saveDucking({ enabled: true, amountDb: 40 }, store);
    expect(loadDucking(store).amountDb).toBe(12);
    expect(loadDucking(null)).toEqual(DEFAULT_DUCKING);
  });
});

describe('headphones', () => {
  it('guesses by the device name', () => {
    for (const label of [
      'Default - AirPods Pro',
      'Headphones (Realtek Audio)',
      'Headset Earphone (Jabra)',
      'Galaxy Buds2',
      'Fone de ouvido (USB)',
      'WH-1000XM4 Headphones',
    ]) {
      expect(outputKind(label), label).toBe('headphones');
    }
    for (const label of ['Speakers (Realtek Audio)', 'Alto-falantes', 'LG HDR 4K (HDMI)']) {
      expect(outputKind(label), label).toBe('speakers');
    }
    expect(outputKind('USB Audio Device')).toBe('unknown');
    expect(outputKind(undefined)).toBe('unknown');
  });

  it('the system default is the `default` entry, named after the device', () => {
    const devices = [
      { deviceId: 'default', kind: 'audiooutput' as const, label: 'Default - AirPods' },
      { deviceId: 'd_spk', kind: 'audiooutput' as const, label: 'Speakers' },
      { deviceId: 'default', kind: 'audioinput' as const, label: 'Default - Mic' },
    ];
    expect(outputLabel(devices, '')).toBe('Default - AirPods');
    expect(outputLabel(devices, 'd_spk')).toBe('Speakers');
    expect(outputLabel(devices, 'gone')).toBeUndefined();
  });

  it('warns above 100 % unless it looks like headphones (unknown warns)', () => {
    expect(warnBoost(1, 'Speakers')).toBe(false);
    expect(warnBoost(1.5, 'Speakers')).toBe(true);
    expect(warnBoost(1.5, undefined)).toBe(true);
    expect(warnBoost(1.5, 'AirPods')).toBe(false);
  });
});

describe('one-time tips', () => {
  it('shows the first time it applies, then not again on this device', () => {
    const first = renderHook(({ applies }) => useTip('t1', applies), {
      initialProps: { applies: false },
    });
    expect(first.result.current.show).toBe(false);
    // Not applying yet: not used up.
    expect(tipSeen('t1')).toBe(false);
    first.rerender({ applies: true });
    expect(first.result.current.show).toBe(true);
    expect(tipSeen('t1')).toBe(true);
    first.unmount();
    const again = renderHook(() => useTip('t1', true));
    expect(again.result.current.show).toBe(false);
  });

  it('dismiss hides it at once', () => {
    const { result } = renderHook(() => useTip('t2', true));
    act(() => result.current.dismiss());
    expect(result.current.show).toBe(false);
  });

  it('broken storage: the tip shows rather than never', () => {
    const broken = {
      getItem: () => '{nope',
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(tipSeen('t3', broken)).toBe(false);
    expect(() => markTipSeen('t3', broken)).not.toThrow();
  });

  it('iOS: iPhone, and an iPad that says it is a Mac', () => {
    const ua = {
      iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
      mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile',
    };
    expect(isIos({ userAgent: ua.iphone, maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: ua.mac, maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: ua.mac, maxTouchPoints: 0 })).toBe(false);
    expect(isIos({ userAgent: ua.android, maxTouchPoints: 5 })).toBe(false);
  });
});
