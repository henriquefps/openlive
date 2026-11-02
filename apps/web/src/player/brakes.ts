// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import type { WatchMedia } from './media.ts';

// Viewer cost brakes 5 and 6, both on by default and switchable per instance
// (`viewerBrakes` in /api/me, the admin settings):
//
// 5. A tab that is not visible for BACKGROUND_PAUSE_MS stops receiving video. Decision: the slot
//    lease is kept (the room socket keeps renewing it) and only the media stops: the pulled tracks
//    are closed at the SFU (POST .../unsubscribe), which ends the egress, the cost this brake is
//    about. When the tab is visible again the stream is pulled again on the session that is still
//    connected, one round trip, so coming back is fast and never meets a full stream. Picture in
//    picture and full screen count as visible: someone watching a PiP window or a full-screen
//    player on another monitor is watching.
// 6. After IDLE_MS without any interaction while watching, "Still watching?". Without an answer in
//    IDLE_ANSWER_MS, watching stops and the slot is released (the same path as closing the player).
//
// The controllers are plain classes on injectable timers and environment so the tests drive them
// with fake timers; useViewerBrakes wires them to the document.

export const BACKGROUND_PAUSE_MS = 60_000;
export const IDLE_MS = 2 * 60 * 60_000;
export const IDLE_ANSWER_MS = 60_000;

/** Visible enough to be watched: the tab, a picture-in-picture window or a full-screen player. */
export function isWatchable(doc: Document = document): boolean {
  const pip = (globalThis as { documentPictureInPicture?: { window: Window | null } })
    .documentPictureInPicture;
  return (
    doc.visibilityState === 'visible' ||
    doc.pictureInPictureElement != null ||
    doc.fullscreenElement != null ||
    (pip?.window != null && !pip.window.closed)
  );
}

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

/** What counts as interacting with the page for brake 6. */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
/** pointermove fires constantly; one restart per this long is enough. */
const ACTIVITY_THROTTLE_MS = 5_000;

export interface ViewerBrakeSettings {
  backgroundPause: boolean;
  idleCheck: boolean;
}

/**
 * Brakes 5 and 6 for the stream being watched: `media` is the watched stream's media (null while
 * there is none), `onIdleStop` stops watching (it releases the slot).
 */
export function useViewerBrakes(
  media: WatchMedia | null,
  settings: ViewerBrakeSettings,
  onIdleStop: () => void,
): { backgroundPaused: boolean; idle: IdleState; confirmWatching: () => void } {
  const [backgroundPaused, setBackgroundPaused] = useState(false);
  const [idle, setIdle] = useState<IdleState>({ kind: 'watching' });
  const idleRef = useRef<IdleCheck | null>(null);
  const stopRef = useRef(onIdleStop);
  useEffect(() => {
    stopRef.current = onIdleStop;
  });

  const { backgroundPause, idleCheck } = settings;

  useEffect(() => {
    if (!media || !backgroundPause || !media.suspend || !media.resume) return;
    const suspend = media.suspend.bind(media);
    const resume = media.resume.bind(media);
    const brake = new BackgroundPause({ suspend, resume, onChange: setBackgroundPaused });
    const update = () => brake.update(isWatchable());
    update();
    document.addEventListener('visibilitychange', update);
    document.addEventListener('fullscreenchange', update);
    // Not bubbling: listened to on the way down (capture).
    document.addEventListener('enterpictureinpicture', update, true);
    document.addEventListener('leavepictureinpicture', update, true);
    return () => {
      document.removeEventListener('visibilitychange', update);
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('enterpictureinpicture', update, true);
      document.removeEventListener('leavepictureinpicture', update, true);
      if (brake.isPaused) resume();
      brake.dispose();
      setBackgroundPaused(false);
    };
  }, [media, backgroundPause]);

  useEffect(() => {
    if (!media || !idleCheck) return;
    const check = new IdleCheck({
      onChange: setIdle,
      onTimeout: () => stopRef.current(),
    });
    idleRef.current = check;
    let last = 0;
    const activity = () => {
      const now = Date.now();
      if (now - last < ACTIVITY_THROTTLE_MS) return;
      last = now;
      check.activity();
    };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, activity, { passive: true });
    check.start();
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, activity);
      check.dispose();
      idleRef.current = null;
      setIdle({ kind: 'watching' });
    };
  }, [media, idleCheck]);

  return {
    backgroundPaused,
    idle,
    confirmWatching: () => idleRef.current?.confirm(),
  };
}
