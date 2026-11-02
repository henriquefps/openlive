// SPDX-License-Identifier: AGPL-3.0-only
import type { NoticeKind, NoticeSettings } from './settings.ts';
import type { Sound, SoundOutput } from './sounds.ts';

// What each notice does: which setting turns it on, its
// sound, its toast, and how often it may repeat. Sounds play only once the page has had an
// interaction (the autoplay rules) and while the tab is open, background included; the toast
// comes with every notice, for people with the sound off. Your own voice join and leave are the
// exception: the button you just pressed already shows it, so they only sound.

export type NoticeEvent =
  | 'voiceJoinSelf'
  | 'voiceLeaveSelf'
  | 'voiceJoin'
  | 'voiceLeave'
  | 'streamStarted'
  | 'queueSlot'
  | 'viewerJoined'
  | 'streamDropped'
  | 'streamUnstable'
  | 'mention';

interface EventRule {
  kind: NoticeKind;
  sound: Sound;
  toast: boolean;
  /** At most once in this long (the helper's gaps, helper/internal/notify). */
  gapMs?: number;
}

export const EVENT_RULES: Record<NoticeEvent, EventRule> = {
  voiceJoinSelf: { kind: 'voiceSelf', sound: 'join', toast: false },
  voiceLeaveSelf: { kind: 'voiceSelf', sound: 'leave', toast: false },
  voiceJoin: { kind: 'voiceOthers', sound: 'join', toast: true },
  voiceLeave: { kind: 'voiceOthers', sound: 'leave', toast: true },
  streamStarted: { kind: 'streamStarted', sound: 'start', toast: true },
  queueSlot: { kind: 'queueSlot', sound: 'slot', toast: true },
  viewerJoined: { kind: 'viewerJoined', sound: 'viewer', toast: true, gapMs: 30_000 },
  streamDropped: { kind: 'streamProblem', sound: 'alert', toast: true },
  streamUnstable: { kind: 'streamProblem', sound: 'alert', toast: true, gapMs: 120_000 },
  mention: { kind: 'mention', sound: 'mention', toast: true },
};

export interface Decision {
  toast: boolean;
  sound: Sound | null;
}

/** What a notice does now: null when it is turned off. */
export function decide(
  settings: NoticeSettings,
  event: NoticeEvent,
  interacted: boolean,
): Decision | null {
  const rule = EVENT_RULES[event];
  if (!settings.events[rule.kind]) return null;
  const audible = interacted && !settings.muted && settings.volume > 0;
  return { toast: rule.toast, sound: audible ? rule.sound : null };
}

/** A notice's words, ready for the toast. */
export interface NoticeText {
  title: string;
  description?: string | undefined;
}

export interface NotifierOptions {
  settings: () => NoticeSettings;
  sounds: SoundOutput;
  toast: (event: NoticeEvent, text: NoticeText) => void;
  /** The page has had an interaction (navigator.userActivation, or a click seen). */
  interacted: () => boolean;
  now?: () => number;
}

/** Turns notices into a sound and a toast, by the settings and the rules above. */
export class Notifier {
  private readonly last = new Map<NoticeEvent, number>();
  private readonly now: () => number;

  constructor(private readonly options: NotifierOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether the notice went out (false: turned off, or too soon after the last one). */
  notify(event: NoticeEvent, text: NoticeText): boolean {
    const settings = this.options.settings();
    const decision = decide(settings, event, this.options.interacted());
    if (!decision) return false;
    const gap = EVENT_RULES[event].gapMs;
    const now = this.now();
    const last = this.last.get(event);
    if (gap !== undefined && last !== undefined && now - last < gap) return false;
    this.last.set(event, now);
    if (decision.sound) this.options.sounds.play(decision.sound, settings.volume);
    if (decision.toast) this.options.toast(event, text);
    return true;
  }
}
