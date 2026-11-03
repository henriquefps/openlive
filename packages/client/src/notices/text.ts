// SPDX-License-Identifier: AGPL-3.0-only
import type { RoomState } from '../room/connection.ts';
import type { NoticeEvent, NoticeText } from './policy.ts';
import type { Notice } from './watch.ts';

// The words of a notice's toast, from the shared `notices.*` texts (locales). `t` is i18next's.

/** The part of i18next's `t` used here. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

function nameOf(room: RoomState, userId: string | undefined, t: Translate): string {
  return room.members.find((m) => m.userId === userId)?.displayName ?? t('player.someone');
}

/** What a notice from a room's socket says. */
export function roomNoticeText(notice: Notice, room: RoomState, t: Translate): NoticeText {
  const name = nameOf(room, notice.userId, t);
  const where = room.room?.name;
  switch (notice.event) {
    case 'streamStarted':
      return { title: t('notices.streamStarted', { name }), description: where };
    case 'queueSlot':
      return { title: t('notices.queueSlot', { name }), description: t('notices.queueSlotHint') };
    case 'viewerJoined':
      return { title: t('notices.viewerJoined', { name }) };
    case 'voiceJoin':
      return { title: t('notices.voiceJoin', { name }), description: where };
    case 'voiceLeave':
      return { title: t('notices.voiceLeave', { name }), description: where };
    case 'voiceJoinSelf':
      return { title: t('notices.voiceJoinSelf'), description: where };
    case 'voiceLeaveSelf':
      return { title: t('notices.voiceLeaveSelf'), description: where };
    case 'streamDropped':
    case 'streamUnstable':
    case 'mention':
      return hubNoticeText(notice.event, t);
  }
}

/** Your own streams' notices (and the mention, said by the chat). */
export function hubNoticeText(event: NoticeEvent, t: Translate): NoticeText {
  switch (event) {
    case 'streamDropped':
      return { title: t('notices.streamDropped'), description: t('notices.streamDroppedHint') };
    case 'streamUnstable':
      return { title: t('notices.streamUnstable'), description: t('notices.streamUnstableHint') };
    default:
      return { title: t('chat.mentionElsewhere') };
  }
}
