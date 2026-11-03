// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { TOAST_MAX, ToastStore, type Timers } from '../src/notices/toasts.ts';

function fakeTimers() {
  let now = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const timers: Timers = {
    set: (fn, ms) => {
      jobs.set(next, { at: now + ms, fn });
      return next++;
    },
    clear: (h) => void jobs.delete(h as number),
  };
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, job] of [...jobs]) {
        if (job.at <= now) {
          jobs.delete(id);
          job.fn();
        }
      }
    },
  };
}

describe('ToastStore', () => {
  it('shows a toast and removes it by itself', () => {
    const t = fakeTimers();
    const store = new ToastStore(t.timers, 1000);
    store.show({ title: 'A' });
    expect(store.getState().map((x) => x.title)).toEqual(['A']);
    t.advance(999);
    expect(store.getState()).toHaveLength(1);
    t.advance(1);
    expect(store.getState()).toHaveLength(0);
  });

  it('the same text again restarts its time instead of stacking', () => {
    const t = fakeTimers();
    const store = new ToastStore(t.timers, 1000);
    store.show({ title: 'A', description: 'x' });
    t.advance(800);
    store.show({ title: 'A', description: 'x' });
    t.advance(800);
    expect(store.getState()).toHaveLength(1);
    t.advance(200);
    expect(store.getState()).toHaveLength(0);
  });

  it('keeps the newest few, dismisses on demand and tells the listeners', () => {
    const t = fakeTimers();
    const store = new ToastStore(t.timers, 1000);
    let calls = 0;
    store.subscribe(() => (calls += 1));
    for (let i = 0; i < TOAST_MAX + 2; i += 1) store.show({ title: `T${i}` });
    expect(store.getState().map((x) => x.title)).toEqual(['T2', 'T3', 'T4']);
    store.dismiss(store.getState()[0]?.id ?? 0);
    expect(store.getState()).toHaveLength(2);
    expect(calls).toBeGreaterThan(0);
    expect(store.show({ title: 'W', kind: 'warning' })).toBeGreaterThan(0);
    expect(store.getState().at(-1)?.kind).toBe('warning');
  });
});
