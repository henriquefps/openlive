// SPDX-License-Identifier: AGPL-3.0-only
// Settings → Notifications: the model is in
// @openlive/client (notices/settings.ts), shared with the mobile app; here it is kept in this
// browser's localStorage, which can be missing or full (reads fall back, writes are dropped).
import {
  loadNoticeSettings as load,
  NoticeSettingsStore,
  saveNoticeSettings as save,
  type NoticeSettings,
  type SettingsStorage,
} from '@openlive/client';

export {
  clampNoticeVolume,
  DEFAULT_NOTICE_SETTINGS,
  NOTICE_KINDS,
  NoticeSettingsStore,
  type NoticeKind,
  type NoticeSettings,
  type SettingsStorage,
} from '@openlive/client';

function storage(): SettingsStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export const loadNoticeSettings = (store: SettingsStorage | null = storage()): NoticeSettings =>
  load(store);

export const saveNoticeSettings = (
  settings: NoticeSettings,
  store: SettingsStorage | null = storage(),
): void => save(settings, store);

export const noticeSettings = new NoticeSettingsStore(storage);
