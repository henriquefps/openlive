// SPDX-License-Identifier: AGPL-3.0-only
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useHub } from '../hub/use-hub.ts';
import { useNotify } from '../notices/AppNotices.tsx';
import { isChatOpen } from './api.ts';

// Mentions anywhere in the app (docs/PROTOCOL.md 7.6): the room sends the hub notice chat_mention
// to the user's tabs. A tab with that room's chat open shows the mention there instead; every
// other tab plays the mention sound with a toast (notices/, if turned on) and refreshes the
// unread counts.

export function MentionNotices() {
  const { t } = useTranslation();
  const { state } = useHub();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const seen = useRef(0);
  const notice = state.notice;
  useEffect(() => {
    if (!notice || notice.seq <= seen.current) return;
    seen.current = notice.seq;
    const { event, roomId } = notice.payload;
    if (event !== 'chat_mention' || roomId === undefined) return;
    void queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === 'space' && q.queryKey[2] === 'chatUnread',
    });
    if (!isChatOpen(roomId)) notify('mention', { title: t('chat.mentionElsewhere') });
  }, [notice, queryClient, notify, t]);
  return null;
}
