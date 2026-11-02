// SPDX-License-Identifier: AGPL-3.0-only
import type { StreamInfo } from '@openlive/protocol';
import type { WatchAccess } from '../room/connection.ts';
import type { RtcSession } from './session.ts';
import { RtcSource } from './source.ts';

// Pull on hover: when the pointer rests on a stream
// card, the viewer takes a slot and pulls the stream's `q` layer (480p30) on the room's already
// connected SFU session, playing it in a hidden muted <video> so frames are decoded. A click then
// hands that source to the watch view, which shows the frames it already has and switches up with
// tracks/update (the SFU asks the helper for a keyframe on the new layer). Without a
// click the pull and the slot are released `holdMs` after the pointer leaves, and after `maxMs`
// in any case.
//
// Cost: a pre-pull holds a real viewer slot, so it counts against the viewer
// limit; the room's meter charges the slot at the `q` layer's bitrate plus one join at the top
// layer's (the SFU starts every pull there); a full stream is never pre-pulled (no queue). One
// pre-pull at a time per room view; desktop pointers only (no hover on phones, and their data
// plans would pay for egress nobody asked for).

export const PREPULL_LAYER = 'q';

export interface PrePullOptions {
  /** The pointer must rest this long on a card before anything is requested. */
  dwellMs?: number;
  /** Release this long after the pointer leaves without a click. */
  holdMs?: number;
  /** Release this long after the hover started, even if the pointer stays. */
  maxMs?: number;
  /** Plays the pre-pulled stream somewhere hidden so it decodes; returns the cleanup. */
  warm?: (stream: MediaStream) => () => void;
  createSource?: (session: RtcSession, stream: StreamInfo, slotId: string) => RtcSource;
  now?: () => number;
}

/** The room socket's slot requests, as the watch view uses them. */
export interface SlotActions {
  watch(streamId: string): void;
  unwatch(streamId: string): void;
}

interface Entry {
  stream: StreamInfo;
  phase: 'dwelling' | 'requesting' | 'pulled';
  timer: ReturnType<typeof setTimeout> | null;
  deadline: ReturnType<typeof setTimeout> | null;
  slotId: string | null;
  source: RtcSource | null;
  unwarm: (() => void) | null;
  pulledAt: number | null;
}

/** A source taken over from a pre-pull. */
export interface PrePulled {
  source: RtcSource;
  /** ms from the pull to the take: how much of the pull the hover hid. */
  leadMs: number;
}

/** Plays a stream in a detached, muted video element, so the browser decodes its frames. */
export function warmInHiddenVideo(stream: MediaStream): () => void {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  void video.play().catch(() => undefined);
  return () => {
    video.pause();
    video.srcObject = null;
  };
}

export class PrePuller {
  private entry: Entry | null = null;
  /** Clicked, waiting for the watch view to take it: no timer may release it any more. */
  private claimed: Entry | null = null;
  /**
   * Taken over by the watch view. Counted, so a remount (React StrictMode replays effects in
   * development, calling the media factory twice) shares the source instead of pulling anew;
   * it stops one task after the last holder lets go.
   */
  private lent: { streamId: string; slotId: string; source: RtcSource; holders: number } | null =
    null;
  private readonly dwellMs: number;
  private readonly holdMs: number;
  private readonly maxMs: number;
  private readonly warm: (stream: MediaStream) => () => void;
  private readonly createSource: (
    session: RtcSession,
    stream: StreamInfo,
    slotId: string,
  ) => RtcSource;
  private readonly now: () => number;

  constructor(
    private readonly session: RtcSession,
    private readonly actions: SlotActions,
    options: PrePullOptions = {},
  ) {
    this.dwellMs = options.dwellMs ?? 150;
    this.holdMs = options.holdMs ?? 5_000;
    this.maxMs = options.maxMs ?? 20_000;
    this.warm = options.warm ?? warmInHiddenVideo;
    this.createSource =
      options.createSource ??
      ((session, stream, slotId) => {
        const source = new RtcSource(session, { stream, slotId });
        // The first pull asks for this layer (rtc/source.ts pulls on `layer` when it is set).
        source.layer = PREPULL_LAYER;
        return source;
      });
    this.now = options.now ?? (() => performance.now());
  }

  /** The stream being pre-pulled (or about to be), for tests and the e2e. */
  get streamId(): string | null {
    return this.entry?.stream.streamId ?? null;
  }

  get phase(): Entry['phase'] | null {
    return this.entry?.phase ?? null;
  }

  /**
   * The pointer rests on a stream card. `access` is what the room already holds for it: a stream
   * the viewer watches, waits for or was refused is left alone.
   */
  hover(stream: StreamInfo, access: WatchAccess | undefined): void {
    const current = this.entry;
    if (current?.stream.streamId === stream.streamId) {
      // Back on the same card: keep it.
      if (current.phase !== 'dwelling' && current.timer !== null) {
        clearTimeout(current.timer);
        current.timer = null;
      }
      return;
    }
    if (stream.paused || access !== undefined) return;
    if (current) this.release();
    const entry: Entry = {
      stream,
      phase: 'dwelling',
      timer: null,
      deadline: null,
      slotId: null,
      source: null,
      unwarm: null,
      pulledAt: null,
    };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.entry !== entry) return;
      entry.phase = 'requesting';
      entry.deadline = setTimeout(() => {
        if (this.entry === entry) this.release();
      }, this.maxMs);
      this.actions.watch(stream.streamId);
    }, this.dwellMs);
    this.entry = entry;
  }

  /** The pointer left the card: release after `holdMs` unless it was clicked or came back. */
  leave(streamId: string): void {
    const entry = this.entry;
    if (!entry || entry.stream.streamId !== streamId) return;
    if (entry.phase === 'dwelling') {
      this.release();
      return;
    }
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.entry === entry) this.release();
    }, this.holdMs);
  }

  /** The room's latest slots: pull once ours is granted; give up when the stream is full. */
  sync(access: Readonly<Record<string, WatchAccess>>): void {
    const entry = this.entry;
    if (!entry || entry.phase !== 'requesting') return;
    // (A claimed request is not pulled here: the watch view pulls on its own once granted.)
    const mine = access[entry.stream.streamId];
    if (mine?.kind === 'granted') {
      entry.phase = 'pulled';
      entry.slotId = mine.slotId;
      entry.source = this.createSource(this.session, entry.stream, mine.slotId);
      entry.source.start();
      entry.unwarm = this.warm(entry.source.stream);
      entry.pulledAt = this.now();
    } else if (mine?.kind === 'full' || mine?.kind === 'offer' || mine?.kind === 'denied') {
      // Never queue for a hover.
      this.release();
    }
  }

  /**
   * The viewer clicked this stream: from now on the watch view owns the slot. The pull (if any)
   * waits for `take`.
   */
  claim(streamId: string): void {
    const entry = this.entry;
    if (!entry || entry.stream.streamId !== streamId) return;
    this.clearTimers(entry);
    this.entry = null;
    if (entry.phase === 'dwelling') return;
    this.dropClaimed();
    this.claimed = entry;
  }

  /**
   * The watch view takes the stream over. Returns the pre-pulled source when
   * it was pulled with this slot; either way the pre-pull stops managing the stream (the watch
   * view now owns its slot).
   */
  take(streamId: string, slotId: string): PrePulled | null {
    const lent = this.lent;
    if (lent?.streamId === streamId && lent.slotId === slotId) {
      lent.holders += 1;
      return { source: lent.source, leadMs: 0 };
    }
    let entry = this.claimed;
    if (entry?.stream.streamId === streamId) {
      this.claimed = null;
    } else {
      entry = this.entry;
      if (!entry || entry.stream.streamId !== streamId) return null;
      this.entry = null;
    }
    this.clearTimers(entry);
    entry.unwarm?.();
    if (entry.source && entry.slotId === slotId) {
      if (this.lent) this.lent.source.stop();
      this.lent = { streamId, slotId, source: entry.source, holders: 1 };
      return {
        source: entry.source,
        leadMs: Math.round(this.now() - (entry.pulledAt ?? this.now())),
      };
    }
    entry.source?.stop();
    return null;
  }

  /** A holder of a taken-over source is done with it (the watch view closed). */
  giveBack(source: RtcSource): void {
    const lent = this.lent;
    if (!lent || lent.source !== source) {
      source.stop();
      return;
    }
    lent.holders -= 1;
    if (lent.holders > 0) return;
    setTimeout(() => {
      if (this.lent === lent && lent.holders === 0) {
        this.lent = null;
        lent.source.stop();
      }
    }, 0);
  }

  /** The room view went away (or StrictMode's test unmount): nothing pre-pulled is kept. */
  dispose(): void {
    this.release();
    this.dropClaimed();
  }

  /** A claimed pull the watch view never took: stop it (the slot is the watch view's). */
  private dropClaimed(): void {
    const claimed = this.claimed;
    this.claimed = null;
    if (claimed) this.clearTimers(claimed);
    claimed?.unwarm?.();
    claimed?.source?.stop();
  }

  /** Stops the pull and gives the slot back. */
  private release(): void {
    const entry = this.entry;
    if (!entry) return;
    this.entry = null;
    this.clearTimers(entry);
    entry.unwarm?.();
    entry.source?.stop();
    if (entry.phase !== 'dwelling') this.actions.unwatch(entry.stream.streamId);
  }

  private clearTimers(entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    if (entry.deadline !== null) clearTimeout(entry.deadline);
    entry.timer = null;
    entry.deadline = null;
  }
}

/** Desktop pointers only: a phone has no hover, and pre-pulling there spends its data. */
export function canHover(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true
  );
}

/**
 * The watch view's slot actions with `unwatch` put off by one task, and cancelled by a `watch`
 * of the same stream in between. A slot taken over from a pre-pull is already granted when the
 * watch view mounts, so a remount (React StrictMode replays every effect in development) would
 * otherwise give it back and ask again, dropping the pre-pulled source.
 */
export function deferUnwatch<T extends SlotActions>(actions: T): T {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    ...actions,
    watch(streamId: string) {
      const timer = pending.get(streamId);
      if (timer !== undefined) {
        clearTimeout(timer);
        pending.delete(streamId);
        return;
      }
      actions.watch(streamId);
    },
    unwatch(streamId: string) {
      if (pending.has(streamId)) return;
      pending.set(
        streamId,
        setTimeout(() => {
          pending.delete(streamId);
          actions.unwatch(streamId);
        }, 0),
      );
    },
  };
}
