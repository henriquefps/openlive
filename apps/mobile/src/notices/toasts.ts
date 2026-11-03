// SPDX-License-Identifier: AGPL-3.0-only

// The in-app toasts: short banners at the top, one visible at a time up to a few, each leaving by
// itself. A plain store (no React), so the notifiers anywhere in the app push to it and the host
// component reads it.

export type ToastKind = 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string | undefined;
  /** Tapped: where it leads (a room). */
  onPress?: (() => void) | undefined;
}

export const TOAST_MS = 4_000;
/** The oldest goes when more arrive. */
export const TOAST_MAX = 3;

export type ToastInput = Omit<Toast, 'id' | 'kind'> & { kind?: ToastKind };

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const GLOBAL_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ToastStore {
  private toasts: readonly Toast[] = [];
  private nextId = 1;
  private readonly timers = new Map<number, unknown>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly clock: Timers = GLOBAL_TIMERS,
    private readonly ttlMs = TOAST_MS,
  ) {}

  getState = (): readonly Toast[] => this.toasts;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Shows a toast; the same title and text already showing only restarts its time. */
  show(input: ToastInput): number {
    const same = this.toasts.find(
      (t) => t.title === input.title && t.description === input.description,
    );
    if (same) {
      this.arm(same.id);
      return same.id;
    }
    const toast: Toast = { id: this.nextId++, kind: input.kind ?? 'info', ...input };
    const next = [...this.toasts, toast];
    while (next.length > TOAST_MAX) {
      const dropped = next.shift();
      if (dropped) this.disarm(dropped.id);
    }
    this.toasts = next;
    this.arm(toast.id);
    this.emit();
    return toast.id;
  }

  dismiss(id: number): void {
    this.disarm(id);
    if (!this.toasts.some((t) => t.id === id)) return;
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit();
  }

  private arm(id: number): void {
    this.disarm(id);
    this.timers.set(
      id,
      this.clock.set(() => this.dismiss(id), this.ttlMs),
    );
  }

  private disarm(id: number): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) this.clock.clear(handle);
    this.timers.delete(id);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The app's toasts. */
export const toasts = new ToastStore();
