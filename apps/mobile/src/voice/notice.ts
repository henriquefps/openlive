// SPDX-License-Identifier: AGPL-3.0-only
import type { VoiceEndNotice } from '@openlive/client';
import type { TFunction } from 'i18next';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../notices/notify.ts';
import { voiceSessions } from './host.ts';
import { useVoiceSessionsState } from './hooks.ts';

/** What the end of the voice in a room nobody was looking at says (the web's toast). */
export function noticeTitle(notice: VoiceEndNotice, t: TFunction): string {
  if (notice.kind === 'removed') return t(`voice.removed.${notice.reason}`);
  switch (notice.reason.kind) {
    case 'kicked':
      return t('room.connection.kicked');
    case 'closed':
      return t('room.connection.closed');
    case 'forbidden':
    case 'unauthenticated':
      return t('room.connection.noAccess');
    case 'replaced':
      return t('room.connection.replaced');
    case 'reload':
      return t('room.connection.reload');
  }
}

/** Says once why the call ended while the user was elsewhere in the app. */
export function useVoiceNotice(): void {
  const { t } = useTranslation();
  const { notice } = useVoiceSessionsState();
  useEffect(() => {
    if (!notice) return;
    toast(noticeTitle(notice, t), { description: notice.room || undefined, kind: 'warning' });
    voiceSessions.dismissNotice();
  }, [notice, t]);
}
