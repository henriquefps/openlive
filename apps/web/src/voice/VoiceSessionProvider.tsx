// SPDX-License-Identifier: AGPL-3.0-only
import type { TFunction } from 'i18next';
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useWakeLock } from '../player/hooks.ts';
import type { VoiceEndNotice } from './session.ts';
import {
  type AppVoiceSessions,
  createVoiceSessions,
  VoiceSessionsContext,
} from './use-voice-session.ts';

// The app shell's voice session (session.ts): the room sessions outlive the pages, so the voice
// goes on while the user browses. Joining in another room asks "Switch to <room>?" first; when the
// voice ends in a room nobody is looking at (removed, the room closed), a toast says why. The
// screen stays on while in voice (phones cut the microphone when
// the screen sleeps).

export function VoiceSessionProvider({ children }: { children: ReactNode }) {
  const [sessions] = useState(createVoiceSessions);
  useEffect(() => () => sessions.dispose(), [sessions]);
  const state = useSyncExternalStore(sessions.subscribe, sessions.getState);
  useWakeLock(state.active !== null);
  const { t } = useTranslation();
  useEffect(() => {
    if (!state.notice) return;
    toast(noticeTitle(state.notice, t), { description: state.notice.room || undefined });
    sessions.dismissNotice();
  }, [state.notice, sessions, t]);
  return (
    <VoiceSessionsContext value={sessions}>
      {children}
      <SwitchDialog sessions={sessions} />
    </VoiceSessionsContext>
  );
}

function noticeTitle(notice: VoiceEndNotice, t: TFunction): string {
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

/** "Switch to <room>?": joining voice here leaves the other room's voice. */
function SwitchDialog({ sessions }: { sessions: AppVoiceSessions }) {
  const { t } = useTranslation();
  const { pendingSwitch } = useSyncExternalStore(sessions.subscribe, sessions.getState);
  return (
    <AlertDialog
      open={pendingSwitch !== null}
      onOpenChange={(open) => {
        if (!open) sessions.cancelSwitch();
      }}
    >
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('voice.session.switchTitle', { room: pendingSwitch?.to.name ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('voice.session.switchBody', { room: pendingSwitch?.from.name ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => sessions.confirmSwitch()}>
            {t('voice.session.switch')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
