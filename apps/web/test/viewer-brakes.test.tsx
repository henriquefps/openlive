// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/i18n/index.ts';
import {
  BACKGROUND_PAUSE_MS,
  BackgroundPause,
  IDLE_ANSWER_MS,
  IDLE_MS,
  IdleCheck,
  type IdleState,
  isWatchable,
  useViewerBrakes,
} from '../src/player/brakes.ts';
import type { WatchMedia } from '../src/player/media.ts';
import { StillWatchingDialog } from '../src/player/StillWatchingDialog.tsx';
import { FakeMediaStream, setup } from './rtc-fakes.ts';

// Viewer brakes 5 (background tab) and 6 (idle viewer), on fake timers.

const settle = () => vi.advanceTimersByTimeAsync(0);

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  // Timers and the clock only: the dialog's animation frames run for real, or a 2 h jump would
  // step through every frame.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.stubGlobal('MediaStream', FakeMediaStream);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('brake 5: background tab', () => {
  it('suspends after 60 s hidden and resumes as soon as the tab is visible', () => {
    const actions = { suspend: vi.fn(), resume: vi.fn() };
    const brake = new BackgroundPause(actions);
    brake.update(false);
    vi.advanceTimersByTime(BACKGROUND_PAUSE_MS - 1);
    expect(actions.suspend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(actions.suspend).toHaveBeenCalledTimes(1);
    expect(brake.isPaused).toBe(true);
    // Hidden again (another event) does nothing more.
    brake.update(false);
    vi.advanceTimersByTime(BACKGROUND_PAUSE_MS);
    expect(actions.suspend).toHaveBeenCalledTimes(1);
    brake.update(true);
    expect(actions.resume).toHaveBeenCalledTimes(1);
    expect(brake.isPaused).toBe(false);
  });

  it('a short trip to another tab changes nothing', () => {
    const actions = { suspend: vi.fn(), resume: vi.fn() };
    const brake = new BackgroundPause(actions);
    brake.update(false);
    vi.advanceTimersByTime(30_000);
    brake.update(true);
    vi.advanceTimersByTime(BACKGROUND_PAUSE_MS * 2);
    expect(actions.suspend).not.toHaveBeenCalled();
    expect(actions.resume).not.toHaveBeenCalled();
  });

  it('picture in picture and full screen count as visible', () => {
    const define = (name: string, value: unknown) =>
      Object.defineProperty(document, name, { configurable: true, get: () => value });
    try {
      visibility = 'hidden';
      define('pictureInPictureElement', null);
      define('fullscreenElement', null);
      expect(isWatchable(document)).toBe(false);
      define('pictureInPictureElement', document.createElement('video'));
      expect(isWatchable(document)).toBe(true);
      define('pictureInPictureElement', null);
      define('fullscreenElement', document.createElement('div'));
      expect(isWatchable(document)).toBe(true);
    } finally {
      // Back to the prototype's (or nothing, in jsdom).
      Reflect.deleteProperty(document, 'pictureInPictureElement');
      Reflect.deleteProperty(document, 'fullscreenElement');
    }
  });

  it('keeps the slot: the rtc source closes its pull, then pulls again with the same slot', async () => {
    const { api, session, source, peer } = setup();
    session.start();
    await settle();
    peer().set('connected');
    const s = source();
    s.start();
    await settle();
    expect(s.state).toEqual({ kind: 'live' });
    expect(api.subscribe).toHaveBeenCalledTimes(1);

    s.suspend();
    await settle();
    expect(api.unsubscribe).toHaveBeenCalledWith('s1', 'st_1');
    // The watchdog's retry does not pull while suspended.
    s.retry();
    await settle();
    expect(api.subscribe).toHaveBeenCalledTimes(1);

    s.resume();
    await settle();
    expect(api.subscribe).toHaveBeenCalledTimes(2);
    expect(api.subscribe.mock.calls[1]?.[0]).toMatchObject({ slotId: 'sl_1', streamId: 'st_1' });
    expect(s.state).toEqual({ kind: 'live' });
  });

  it('wires the document: hidden for 60 s suspends the watched media, visible resumes it', () => {
    const media = { suspend: vi.fn(), resume: vi.fn() } as unknown as WatchMedia;
    const settings = { backgroundPause: true, idleCheck: false };
    const { result, unmount } = renderHook(() => useViewerBrakes(media, settings, vi.fn()));
    act(() => setVisibility('hidden'));
    act(() => void vi.advanceTimersByTime(BACKGROUND_PAUSE_MS));
    expect(media.suspend).toHaveBeenCalledTimes(1);
    expect(result.current.backgroundPaused).toBe(true);
    act(() => setVisibility('visible'));
    expect(media.resume).toHaveBeenCalledTimes(1);
    expect(result.current.backgroundPaused).toBe(false);

    // Unmounting while paused gives the media back.
    act(() => setVisibility('hidden'));
    act(() => void vi.advanceTimersByTime(BACKGROUND_PAUSE_MS));
    unmount();
    expect(media.resume).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the instance turned it off', () => {
    const media = { suspend: vi.fn(), resume: vi.fn() } as unknown as WatchMedia;
    renderHook(() => useViewerBrakes(media, { backgroundPause: false, idleCheck: false }, vi.fn()));
    act(() => setVisibility('hidden'));
    act(() => void vi.advanceTimersByTime(BACKGROUND_PAUSE_MS * 2));
    expect(media.suspend).not.toHaveBeenCalled();
  });
});

describe('brake 6: idle viewer', () => {
  it('asks after 2 h without interaction and stops after 60 s without an answer', () => {
    const states: IdleState[] = [];
    const onTimeout = vi.fn();
    const check = new IdleCheck({ onChange: (s) => states.push(s), onTimeout });
    check.start();
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(check.state.kind).toBe('watching');
    vi.advanceTimersByTime(1);
    expect(check.state).toEqual({ kind: 'asking', deadline: Date.now() + IDLE_ANSWER_MS });
    // Moving the mouse does not answer the question.
    check.activity();
    vi.advanceTimersByTime(IDLE_ANSWER_MS);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(check.state.kind).toBe('watching');
    expect(states.map((s) => s.kind)).toEqual(['asking', 'watching']);
  });

  it('interaction restarts the count, and "Keep watching" answers', () => {
    const onTimeout = vi.fn();
    const check = new IdleCheck({ onChange: () => undefined, onTimeout });
    check.start();
    vi.advanceTimersByTime(IDLE_MS - 1000);
    check.activity();
    vi.advanceTimersByTime(IDLE_MS - 1000);
    expect(check.state.kind).toBe('watching');
    vi.advanceTimersByTime(1000);
    expect(check.state.kind).toBe('asking');
    check.confirm();
    vi.advanceTimersByTime(IDLE_ANSWER_MS * 2);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(check.state.kind).toBe('watching');
  });

  it('shows the dialog with a countdown; no answer stops watching (the slot is released)', () => {
    const media = {} as WatchMedia;
    const stop = vi.fn();
    function View() {
      const brakes = useViewerBrakes(media, { backgroundPause: false, idleCheck: true }, stop);
      return (
        <StillWatchingDialog idle={brakes.idle} onContinue={brakes.confirmWatching} onStop={stop} />
      );
    }
    render(<View />);
    expect(screen.queryByText('Still watching?')).toBeNull();
    act(() => void vi.advanceTimersByTime(IDLE_MS));
    expect(screen.getByText('Still watching?')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(20_000));
    expect(screen.getByText(/Watching stops in 40 s/)).toBeTruthy();
    act(() => void vi.advanceTimersByTime(40_000));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Still watching?')).toBeNull();
  });

  it('"Keep watching" closes the dialog and starts the 2 h over', () => {
    const stop = vi.fn();
    const media = {} as WatchMedia;
    function View() {
      const brakes = useViewerBrakes(media, { backgroundPause: false, idleCheck: true }, stop);
      return (
        <StillWatchingDialog idle={brakes.idle} onContinue={brakes.confirmWatching} onStop={stop} />
      );
    }
    render(<View />);
    act(() => void vi.advanceTimersByTime(IDLE_MS));
    fireEvent.click(screen.getByRole('button', { name: 'Keep watching' }));
    expect(screen.queryByText('Still watching?')).toBeNull();
    act(() => void vi.advanceTimersByTime(IDLE_MS - 1000));
    expect(screen.queryByText('Still watching?')).toBeNull();
    expect(stop).not.toHaveBeenCalled();
  });
});
