// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decide, EVENT_RULES, type NoticeEvent, Notifier } from '../src/notices/policy.ts';
import {
  DEFAULT_NOTICE_SETTINGS,
  loadNoticeSettings,
  NOTICE_KINDS,
  type NoticeSettings,
  NoticeSettingsStore,
  saveNoticeSettings,
} from '../src/notices/settings.ts';
import { NOTES, type Sound, WebAudioSounds } from '../src/notices/sounds.ts';

// The sound notices' policy: the defaults, each toggle and
// "mute all", the autoplay gate, the toast that always comes, and the repeat gaps.

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const settings = (patch: Partial<NoticeSettings> = {}): NoticeSettings => ({
  ...DEFAULT_NOTICE_SETTINGS,
  ...patch,
  events: { ...DEFAULT_NOTICE_SETTINGS.events, ...patch.events },
});

describe('notice settings', () => {
  it('defaults: only "someone started watching you" is off', () => {
    const d = DEFAULT_NOTICE_SETTINGS;
    expect(d.muted).toBe(false);
    expect(d.events).toEqual({
      streamStarted: true,
      queueSlot: true,
      viewerJoined: false,
      streamProblem: true,
      mention: true,
      voiceSelf: true,
      voiceOthers: true,
    });
    expect(Object.keys(d.events).sort()).toEqual([...NOTICE_KINDS].sort());
  });

  it('round-trips, and falls back on garbage or missing storage', () => {
    const store = memory();
    const changed = settings({ muted: true, volume: 0.3, events: { viewerJoined: true } as never });
    saveNoticeSettings(changed, store);
    expect(loadNoticeSettings(store)).toEqual(changed);
    expect(loadNoticeSettings(memory({ 'openlive.notices': '{oops' }))).toEqual(
      DEFAULT_NOTICE_SETTINGS,
    );
    expect(loadNoticeSettings(null)).toEqual(DEFAULT_NOTICE_SETTINGS);
    const partial = memory({
      'openlive.notices': JSON.stringify({ volume: 9, events: { mention: false, bogus: true } }),
    });
    const loaded = loadNoticeSettings(partial);
    expect(loaded.volume).toBe(1);
    expect(loaded.events.mention).toBe(false);
    expect(loaded.events.queueSlot).toBe(true);
    expect('bogus' in loaded.events).toBe(false);
  });

  it('the store merges a toggle, saves it and tells its listeners', () => {
    const store = memory();
    const s = new NoticeSettingsStore(() => store);
    const listener = vi.fn();
    s.subscribe(listener);
    s.update({ events: { streamStarted: false } });
    expect(s.get().events.streamStarted).toBe(false);
    expect(s.get().events.queueSlot).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(loadNoticeSettings(store).events.streamStarted).toBe(false);
  });
});

describe('decide', () => {
  it('a notice turned off does nothing at all', () => {
    expect(decide(settings(), 'viewerJoined', true)).toBeNull();
    expect(decide(settings({ events: { mention: false } as never }), 'mention', true)).toBeNull();
  });

  it('plays only after an interaction (autoplay), with the toast either way', () => {
    expect(decide(settings(), 'streamStarted', false)).toEqual({ toast: true, sound: null });
    expect(decide(settings(), 'streamStarted', true)).toEqual({ toast: true, sound: 'start' });
  });

  it('"mute all" and volume 0 keep the toast and drop the sound', () => {
    expect(decide(settings({ muted: true }), 'queueSlot', true)).toEqual({
      toast: true,
      sound: null,
    });
    expect(decide(settings({ volume: 0 }), 'queueSlot', true)).toEqual({
      toast: true,
      sound: null,
    });
  });

  it('each event has its sound; your own voice join and leave only sound', () => {
    const sounds = Object.fromEntries(
      Object.entries(EVENT_RULES).map(([event, rule]) => [event, rule.sound]),
    );
    expect(sounds).toEqual({
      voiceJoinSelf: 'join',
      voiceLeaveSelf: 'leave',
      voiceJoin: 'join',
      voiceLeave: 'leave',
      streamStarted: 'start',
      queueSlot: 'slot',
      viewerJoined: 'viewer',
      streamDropped: 'alert',
      streamUnstable: 'alert',
      mention: 'mention',
    });
    const quiet = Object.entries(EVENT_RULES).filter(([, rule]) => !rule.toast);
    expect(quiet.map(([event]) => event)).toEqual(['voiceJoinSelf', 'voiceLeaveSelf']);
  });
});

describe('Notifier', () => {
  function setup(patch: Partial<NoticeSettings> = {}, interacted = true) {
    let now = 0;
    const play = vi.fn<(sound: Sound, volume: number) => void>();
    const toast = vi.fn<(event: NoticeEvent, text: { title: string }) => void>();
    const notifier = new Notifier({
      settings: () => settings(patch),
      sounds: { play },
      toast,
      interacted: () => interacted,
      now: () => now,
    });
    return { notifier, play, toast, advance: (ms: number) => (now += ms) };
  }

  it('plays at the chosen volume and shows the toast', () => {
    const n = setup({ volume: 0.4 });
    expect(n.notifier.notify('queueSlot', { title: 'A slot opened' })).toBe(true);
    expect(n.play).toHaveBeenCalledWith('slot', 0.4);
    expect(n.toast).toHaveBeenCalledWith('queueSlot', { title: 'A slot opened' });
  });

  it('before any interaction: the toast, no sound', () => {
    const n = setup({}, false);
    n.notifier.notify('mention', { title: 'Mentioned' });
    expect(n.play).not.toHaveBeenCalled();
    expect(n.toast).toHaveBeenCalledOnce();
  });

  it('keeps the helper gaps: an unstable network at most every 2 minutes', () => {
    const n = setup();
    expect(n.notifier.notify('streamUnstable', { title: 'x' })).toBe(true);
    n.advance(60_000);
    expect(n.notifier.notify('streamUnstable', { title: 'x' })).toBe(false);
    n.advance(60_000);
    expect(n.notifier.notify('streamUnstable', { title: 'x' })).toBe(true);
    // No gap for the drop itself.
    expect(n.notifier.notify('streamDropped', { title: 'x' })).toBe(true);
    expect(n.notifier.notify('streamDropped', { title: 'x' })).toBe(true);
  });

  it('a turned-off notice is not counted for the gap', () => {
    const n = setup();
    expect(n.notifier.notify('viewerJoined', { title: 'x' })).toBe(false);
    expect(n.play).not.toHaveBeenCalled();
    expect(n.toast).not.toHaveBeenCalled();
  });
});

describe('sounds', () => {
  it('start, stop, alert and viewer are the helper sounds, note for note', () => {
    const go = readFileSync(
      path.join(import.meta.dirname, '../../../helper/internal/notify/sound.go'),
      'utf8',
    );
    const helper: Record<string, { hz: number; ms: number }[]> = {};
    for (const [, name, body] of go.matchAll(/Sound(\w+):\s*\{(\{[^\n]*\}),?\s*\},?\n/g)) {
      helper[(name as string).toLowerCase()] = [
        ...(body as string).matchAll(/\{(\d+), (\d+)\}/g),
      ].map(([, hz, ms]) => ({ hz: Number(hz), ms: Number(ms) }));
    }
    expect(Object.keys(helper).sort()).toEqual(['alert', 'start', 'stop', 'viewer']);
    for (const [name, notes] of Object.entries(helper)) {
      expect(NOTES[name as Sound]).toEqual(notes);
    }
  });

  it('every sound is short', () => {
    for (const notes of Object.values(NOTES)) {
      const total = notes.reduce((sum, n) => sum + n.ms, 0);
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(600);
    }
  });

  it('nothing plays before unlock (no AudioContext made without an interaction)', () => {
    const made = vi.fn();
    vi.stubGlobal('AudioContext', made);
    try {
      new WebAudioSounds().play('start', 1);
      expect(made).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('after unlock, each note is an oscillator with a soft envelope', () => {
    const oscillators: { frequency: { value: number }; start: ReturnType<typeof vi.fn> }[] = [];
    const ramps: number[] = [];
    const node = () => ({ connect: (n: unknown) => n, disconnect: vi.fn() });
    vi.stubGlobal(
      'AudioContext',
      class {
        currentTime = 0;
        destination = {};
        resume = () => Promise.resolve();
        close = () => Promise.resolve();
        createOscillator() {
          const osc = {
            ...node(),
            frequency: { value: 0 },
            start: vi.fn(),
            stop: vi.fn(),
            onended: null,
          };
          oscillators.push(osc);
          return osc;
        }
        createGain() {
          return {
            ...node(),
            gain: {
              setValueAtTime: vi.fn(),
              linearRampToValueAtTime: (value: number) => void ramps.push(value),
            },
          };
        }
      },
    );
    try {
      const sounds = new WebAudioSounds();
      sounds.unlock();
      sounds.play('alert', 0.5);
      // Rests make no oscillator.
      expect(oscillators.map((o) => o.frequency.value)).toEqual([988, 988, 740]);
      // Up to 0.25 × 0.5, then down to 0, per note.
      expect(ramps).toEqual([0.125, 0, 0.125, 0, 0.125, 0]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
