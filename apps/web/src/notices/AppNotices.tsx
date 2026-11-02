// SPDX-License-Identifier: AGPL-3.0-only
import type { TFunction } from 'i18next';
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useHub } from '../hub/use-hub.ts';
import type { RoomState } from '../room/connection.ts';
import { streamDucking } from '../voice/ducking.ts';
import {
  type AppRoomSession,
  useActiveVoice,
  useVoiceSessions,
} from '../voice/use-voice-session.ts';
import { type NoticeEvent, type NoticeText, Notifier } from './policy.ts';
import { noticeSettings } from './settings.ts';
import { WebAudioSounds } from './sounds.ts';
import { type Notice, HubNoticeWatcher, RoomNoticeWatcher } from './watch.ts';

// The app's sound notices, in the shell: one notifier for
// the tab, a watcher on each room this tab has open (the pages, the voice), the hub's watcher
// for your own streams, and the stream ducking fed from who speaks in voice. Sounds wait for the
// page's first interaction; the toast never does.

export type Notify = (event: NoticeEvent, text: NoticeText) => void;

const NotifyContext = createContext<Notify | null>(null);

/** Alerts stand out from the rest. */
const WARNING: ReadonlySet<NoticeEvent> = new Set(['streamDropped', 'streamUnstable', 'queueSlot']);

function showToast(event: NoticeEvent, text: NoticeText): void {
  const options = text.description ? { description: text.description } : undefined;
  if (WARNING.has(event)) toast.warning(text.title, options);
  else toast(text.title, options);
}

/** The notifier; outside the shell (tests, dev pages), a toast without sound. */
export function useNotify(): Notify {
  return use(NotifyContext) ?? ((event, text) => showToast(event, text));
}

/** The page has had a click or a key (autoplay): navigator.userActivation where there is one. */
function hasInteracted(seen: boolean): boolean {
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } })
    .userActivation;
  return seen || activation?.hasBeenActive === true;
}

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [sounds] = useState(() => new WebAudioSounds());
  const [gate] = useState(() => ({ seen: false }));
  const [notifier] = useState(
    () =>
      new Notifier({
        settings: noticeSettings.get,
        sounds,
        toast: showToast,
        interacted: () => hasInteracted(gate.seen),
      }),
  );
  useEffect(() => {
    // The first click or key lets the sounds' AudioContext run.
    const unlock = () => {
      gate.seen = true;
      sounds.unlock();
    };
    const types = ['pointerdown', 'keydown'] as const;
    for (const type of types) window.addEventListener(type, unlock, true);
    return () => {
      for (const type of types) window.removeEventListener(type, unlock, true);
      sounds.dispose();
    };
  }, [gate, sounds]);
  const notify = useMemo<Notify>(
    () => (event, text) => void notifier.notify(event, text),
    [notifier],
  );
  return (
    <NotifyContext value={notify}>
      {children}
      <RoomNotices />
      <DuckingFeed />
      <SoundSink sounds={sounds} />
    </NotifyContext>
  );
}

/** A watcher per open room. */
function RoomNotices() {
  const sessions = useVoiceSessions();
  useSyncExternalStore(sessions.subscribe, sessions.getState);
  return sessions
    .openSessions()
    .map((session) => <RoomWatch key={session.roomId} session={session} />);
}

function nameOf(room: RoomState, userId: string | undefined, t: TFunction): string {
  return room.members.find((m) => m.userId === userId)?.displayName ?? t('player.someone');
}

export function roomNoticeText(notice: Notice, room: RoomState, t: TFunction): NoticeText {
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

/** Your own streams' notices (and the mention, said by chat/MentionNotices.tsx). */
export function hubNoticeText(event: NoticeEvent, t: TFunction): NoticeText {
  switch (event) {
    case 'streamDropped':
      return { title: t('notices.streamDropped'), description: t('notices.streamDroppedHint') };
    case 'streamUnstable':
      return { title: t('notices.streamUnstable'), description: t('notices.streamUnstableHint') };
    default:
      return { title: t('chat.mentionElsewhere') };
  }
}

function RoomWatch({ session }: { session: AppRoomSession }) {
  const { t } = useTranslation();
  const notify = useNotify();
  useEffect(() => {
    const { connection } = session.parts;
    const watcher = new RoomNoticeWatcher();
    watcher.update(connection.getState());
    return connection.subscribe(() => {
      const room = connection.getState();
      for (const notice of watcher.update(room)) {
        notify(notice.event, roomNoticeText(notice, room, t));
      }
    });
  }, [session, notify, t]);
  return null;
}

/** Your helpers: a stream that dropped, an unstable network (signed in only). */
export function HubNotices() {
  const { t } = useTranslation();
  const notify = useNotify();
  const { hub } = useHub();
  useEffect(() => {
    const watcher = new HubNoticeWatcher();
    watcher.update(hub.getState());
    return hub.subscribe(() => {
      for (const notice of watcher.update(hub.getState())) {
        notify(notice.event, hubNoticeText(notice.event, t));
      }
    });
  }, [hub, notify, t]);
  return null;
}

/** The sounds play where the voice does: into the voice sink while it does. */
function SoundSink({ sounds }: { sounds: WebAudioSounds }) {
  const sinkId = useActiveVoice()?.voice.voiceSinkId ?? '';
  useEffect(() => {
    sounds.setSink(sinkId);
  }, [sounds, sinkId]);
  return null;
}

/** Ducks the stream while someone else in your voice speaks; not while deafened. */
function DuckingFeed() {
  const active = useActiveVoice();
  const selfId = active?.room.voice.selfId;
  const speaking =
    active !== null &&
    !active.voice.deafened &&
    Object.entries(active.voice.speaking).some(
      // 'self' is the client's own id before the room says it (client.ts).
      ([id, on]) => on && id !== selfId && id !== 'self',
    );
  useEffect(() => {
    streamDucking.setSpeaking(speaking);
  }, [speaking]);
  useEffect(() => () => streamDucking.setSpeaking(false), []);
  return null;
}
