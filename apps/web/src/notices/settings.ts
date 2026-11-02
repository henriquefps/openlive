// SPDX-License-Identifier: AGPL-3.0-only
// Settings → Notifications: each notice on or off, "mute
// all" and the volume, for this browser. localStorage, like the voice prefs (voice/prefs.ts):
// storage can be missing or full, so reads fall back to the defaults and writes are dropped. One
// store per tab, so the settings card and the notices see a change at once.

/** The notices a person turns on or off, as the settings card lists them. */
export const NOTICE_KINDS = [
  'streamStarted',
  'queueSlot',
  'viewerJoined',
  'streamProblem',
  'mention',
  'voiceSelf',
  'voiceOthers',
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export interface NoticeSettings {
  /** "Mute all": the toasts stay, the sounds stop. */
  muted: boolean;
  /** 0–1. */
  volume: number;
  events: Record<NoticeKind, boolean>;
}

/** The defaults: someone watching your stream is the one off. */
export const DEFAULT_NOTICE_SETTINGS: NoticeSettings = {
  muted: false,
  volume: 0.7,
  events: {
    streamStarted: true,
    queueSlot: true,
    viewerJoined: false,
    streamProblem: true,
    mention: true,
    voiceSelf: true,
    voiceOthers: true,
  },
};

const KEY = 'openlive.notices';

export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): SettingsStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function clampNoticeVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_NOTICE_SETTINGS.volume;
  return Math.round(Math.min(1, Math.max(0, volume)) * 100) / 100;
}

export function loadNoticeSettings(store: SettingsStorage | null = storage()): NoticeSettings {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return DEFAULT_NOTICE_SETTINGS;
    const value = JSON.parse(raw) as Partial<NoticeSettings>;
    const saved = (value.events ?? {}) as Partial<Record<NoticeKind, unknown>>;
    const events = { ...DEFAULT_NOTICE_SETTINGS.events };
    for (const kind of NOTICE_KINDS) {
      if (typeof saved[kind] === 'boolean') events[kind] = saved[kind];
    }
    return {
      muted: value.muted === true,
      volume:
        typeof value.volume === 'number'
          ? clampNoticeVolume(value.volume)
          : DEFAULT_NOTICE_SETTINGS.volume,
      events,
    };
  } catch {
    return DEFAULT_NOTICE_SETTINGS;
  }
}

export function saveNoticeSettings(
  settings: NoticeSettings,
  store: SettingsStorage | null = storage(),
): void {
  try {
    store?.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not remembered this time.
  }
}

/** The tab's settings, read once and kept in step with the settings card. */
export class NoticeSettingsStore {
  private settings: NoticeSettings | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: () => SettingsStorage | null = storage) {}

  get = (): NoticeSettings => (this.settings ??= loadNoticeSettings(this.store()));

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(
    patch: Partial<Omit<NoticeSettings, 'events'>> & { events?: Partial<NoticeSettings['events']> },
  ): void {
    const current = this.get();
    const next: NoticeSettings = {
      muted: patch.muted ?? current.muted,
      volume: patch.volume === undefined ? current.volume : clampNoticeVolume(patch.volume),
      events: { ...current.events, ...patch.events },
    };
    this.settings = next;
    saveNoticeSettings(next, this.store());
    for (const listener of this.listeners) listener();
  }
}

export const noticeSettings = new NoticeSettingsStore();
