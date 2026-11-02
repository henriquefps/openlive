// SPDX-License-Identifier: AGPL-3.0-only
// "Abaixar a transmissão": while someone speaks in voice, the
// stream you watch gets quieter by a few dB, and comes back when they stop. Who speaks comes from
// the voice's own level meter (levels.ts), which already holds through the gaps between words; the
// envelope here ramps in dB, quickly down (attack) and slowly back (release), so it does not pump.
// The player multiplies its volume by `gain()` (player/Player.tsx). On by default, and turned
// off or set deeper in Settings → Voice; kept under its own key, so an open voice client saving
// its prefs (prefs.ts) cannot undo a change.

export const DUCK_ATTACK_MS = 120;
export const DUCK_RELEASE_MS = 700;
/** The amounts Settings → Voice offers, in dB below the stream's volume. */
export const DUCK_AMOUNTS_DB = [6, 12, 18] as const;
export const DEFAULT_DUCK_DB = 12;

export const dbToGain = (db: number): number => 10 ** (db / 20);

/** A ramp in dB between 0 (full) and -amount (ducked), over the attack or the release. */
export class DuckEnvelope {
  private from = 0;
  private to = 0;
  private start = 0;
  private length = 0;

  constructor(
    private readonly attackMs = DUCK_ATTACK_MS,
    private readonly releaseMs = DUCK_RELEASE_MS,
  ) {}

  /** Sets where the ramp heads from now: -amountDb while ducked, 0 when not. */
  target(ducked: boolean, amountDb: number, now: number): void {
    const to = ducked ? -Math.abs(amountDb) : 0;
    if (to === this.to) return;
    this.from = this.db(now);
    this.to = to;
    this.start = now;
    const span = Math.abs(to - this.from);
    const full = Math.max(Math.abs(amountDb), 1);
    // A partial ramp (a change of mind halfway) takes its share of the time.
    this.length = ((to < this.from ? this.attackMs : this.releaseMs) * span) / full;
  }

  /** The level now, in dB (0 or below). */
  db(now: number): number {
    if (this.length <= 0 || now >= this.start + this.length) return this.to;
    const t = Math.max(0, (now - this.start) / this.length);
    return this.from + (this.to - this.from) * t;
  }

  gain(now: number): number {
    return dbToGain(this.db(now));
  }

  settled(now: number): boolean {
    return this.length <= 0 || now >= this.start + this.length;
  }
}

export interface DuckingPrefs {
  enabled: boolean;
  /** One of DUCK_AMOUNTS_DB. */
  amountDb: number;
}

export const DEFAULT_DUCKING: DuckingPrefs = { enabled: true, amountDb: DEFAULT_DUCK_DB };
const KEY = 'openlive.ducking';

interface DuckingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): DuckingStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function loadDucking(store: DuckingStorage | null = storage()): DuckingPrefs {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return DEFAULT_DUCKING;
    const value = JSON.parse(raw) as Partial<DuckingPrefs>;
    return {
      enabled: value.enabled !== false,
      amountDb:
        typeof value.amountDb === 'number' &&
        (DUCK_AMOUNTS_DB as readonly number[]).includes(value.amountDb)
          ? value.amountDb
          : DEFAULT_DUCK_DB,
    };
  } catch {
    return DEFAULT_DUCKING;
  }
}

export function saveDucking(prefs: DuckingPrefs, store: DuckingStorage | null = storage()): void {
  try {
    store?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered this time.
  }
}

const TICK_MS = 25;

/** The tab's ducking: one stream plays with sound at a time, so one value. */
export class StreamDucking {
  private readonly envelope = new DuckEnvelope();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private value = 1;
  private speaking = false;
  private prefs: DuckingPrefs | null = null;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly store: () => DuckingStorage | null = storage,
  ) {}

  getPrefs = (): DuckingPrefs => (this.prefs ??= loadDucking(this.store()));

  setPrefs(patch: Partial<DuckingPrefs>): void {
    this.prefs = { ...this.getPrefs(), ...patch };
    saveDucking(this.prefs, this.store());
    this.apply();
    for (const listener of this.listeners) listener();
  }

  /** The factor for the stream's volume now, 0–1. */
  gain = (): number => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Someone in voice speaks (or nobody does): ducks, if turned on, or restores. */
  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    this.apply();
  }

  private apply(): void {
    const { enabled, amountDb } = this.getPrefs();
    this.envelope.target(enabled && this.speaking, amountDb, this.now());
    this.tick();
  }

  private tick(): void {
    const now = this.now();
    const value = this.envelope.gain(now);
    if (value !== this.value) {
      this.value = value;
      for (const listener of this.listeners) listener();
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    // Timers, not animation frames: the stream plays on with the tab in the background.
    if (!this.envelope.settled(now)) this.timer = setTimeout(() => this.tick(), TICK_MS);
  }
}

export const streamDucking = new StreamDucking();
