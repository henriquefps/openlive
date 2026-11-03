// SPDX-License-Identifier: AGPL-3.0-only

// Viewer cost brakes 5 and 6, as plain classes on injectable timers: the web wires
// them to the document, the app to its foreground state.
//
// 5. Not watchable (tab hidden, app in the background) for BACKGROUND_PAUSE_MS stops receiving
//    video; the slot lease is kept, only the media stops, and coming back pulls again.
// 6. After IDLE_MS without any interaction while watching, "Still watching?". Without an answer in
//    IDLE_ANSWER_MS, watching stops and the slot is released.

export const BACKGROUND_PAUSE_MS = 60_000;
export const IDLE_MS = 2 * 60 * 60_000;
export const IDLE_ANSWER_MS = 60_000;

/** Brake 5: suspends after `delayMs` of not being watchable, resumes as soon as it is again. */
export class BackgroundPause {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;

  constructor(
    private readonly actions: { suspend(): void; resume(): void; onChange?(paused: boolean): void },
    private readonly delayMs = BACKGROUND_PAUSE_MS,
  ) {}

  get isPaused(): boolean {
    return this.paused;
  }

  /** Call on every change that may affect visibility (and once at the start). */
  update(watchable: boolean): void {
    if (watchable) {
      this.clear();
      if (this.paused) {
        this.paused = false;
        this.actions.resume();
        this.actions.onChange?.(false);
      }
      return;
    }
    if (this.paused || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.paused = true;
      this.actions.suspend();
      this.actions.onChange?.(true);
    }, this.delayMs);
  }

  dispose(): void {
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

export type IdleState = { kind: 'watching' } | { kind: 'asking'; deadline: number };

/** Brake 6: asks after `idleMs` without activity; stops after `answerMs` without an answer. */
export class IdleCheck {
  state: IdleState = { kind: 'watching' };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly actions: { onChange(state: IdleState): void; onTimeout(): void },
    private readonly idleMs = IDLE_MS,
    private readonly answerMs = IDLE_ANSWER_MS,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.watch();
  }

  /** Any interaction while watching restarts the count; it does not answer an open question. */
  activity(): void {
    if (this.state.kind === 'watching') this.watch();
  }

  /** "Keep watching". */
  confirm(): void {
    this.set({ kind: 'watching' });
    this.watch();
  }

  dispose(): void {
    this.clear();
  }

  private watch(): void {
    this.clear();
    this.timer = setTimeout(() => this.ask(), this.idleMs);
  }

  private ask(): void {
    this.set({ kind: 'asking', deadline: this.now() + this.answerMs });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.set({ kind: 'watching' });
      this.actions.onTimeout();
    }, this.answerMs);
  }

  private set(state: IdleState): void {
    this.state = state;
    this.actions.onChange(state);
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
