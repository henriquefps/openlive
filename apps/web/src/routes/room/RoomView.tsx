// SPDX-License-Identifier: AGPL-3.0-only
import {
  ArrowClockwiseIcon,
  ArchiveIcon,
  ChatsIcon,
  type Icon,
  MicrophoneIcon,
  PlugsIcon,
  ProhibitIcon,
  SignOutIcon,
  WifiSlashIcon,
} from '@phosphor-icons/react';
import type { RoomCapabilities, You } from '@openlive/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { meQuery } from '../../api/auth.ts';
import { errorBodyOf } from '../../api/client.ts';
import { canManageRoom, isManager } from '../../api/permissions.ts';
import { type Room, roomQuery, type Space, spaceKeys, useArchiveRoom } from '../../api/spaces.ts';
import { roomTrail } from '../../components/breadcrumbs.ts';
import { Page } from '../../components/Page.tsx';
import { QueryError } from '../../components/QueryError.tsx';
import { translateError } from '../../i18n/errors.ts';
import { capabilitiesOf } from '../../lib/capabilities.ts';
import { fakeMediaEnabled, prepullEnabled } from '../../lib/flags.ts';
import { fakeMediaFactory, MediaFactoryContext } from '../../player/media.ts';
import { markWatchStart } from '../../player/ttff.ts';
import type { RoomState } from '../../room/connection.ts';
import { ChatPanel } from '../../chat/ChatPanel.tsx';
import { useChat } from '../../chat/use-chat.ts';
import { useBreakpoint } from '../../hooks/use-breakpoint.ts';
import { useRoomSession } from '../../voice/use-voice-session.ts';
import type { RoomLink } from '../../voice/session.ts';
import { type CameraBarProps, JoinVoiceButton, VoiceBar } from '../../voice/VoiceBar.tsx';
import type { VoicePeopleProps } from '../../voice/VoicePeople.tsx';
import { rtcMediaFactory } from '../../rtc/media.ts';
import { canHover, deferUnwatch, PrePuller } from '../../rtc/prepull.ts';
import { quickCode } from '../space/RoomsTab.tsx';
import { Countdown } from './Countdown.tsx';
import { RoomCode } from './RoomCode.tsx';
import { RoomAccessDialog } from './RoomAccessDialog.tsx';
import { RoomFeaturesDialog } from './RoomFeaturesDialog.tsx';
import { BottomBars } from '../../components/BottomBars.tsx';
import { ChatSlideOver, PresenceButton, RoomTitleActions } from './RoomPanels.tsx';
import { RoomStage } from './RoomStage.tsx';
import { streamCards, WatchPanel } from './RoomStreams.tsx';
import { useTutorialScreen } from '../../tutorial/context.ts';
import { GoLiveArea, useLiveHere } from '../../golive/GoLive.tsx';

/**
 * A room: who is here (live), the stream grid and the room's actions, laid out by what
 * the room has: the stream grid only with stream, voice and text
 * as panels beside it, or as the whole page in a voice or text channel.
 */
export function RoomView({ roomId, space }: { roomId: string; space: Space | null }) {
  const { t } = useTranslation();
  const room = useQuery(roomQuery(roomId));
  const me = useQuery(meQuery);
  // The room's session (voice/session.ts): the app's, when it is in voice here, so coming back to
  // the room reuses its socket and voice; else this page's own. The SFU session connects before
  // any click once the room has streams or voice; voice and cameras ride on it
  //, and turning the room's voice off stops them, which leaves.
  const { session, state, rtcStatus, voice, camera, joinVoice } = useRoomSession(roomId, {
    settings: room.data?.effectiveSettings ?? null,
    name: room.data?.name ?? null,
    link: roomLink(space, room.data, roomId),
  });
  const { actions, moderation, chat: chatSocket, pointer } = session.parts.socket;
  const reconnect = () => session.parts.connection.reconnect();
  // The text chat; a mention while it is out of sight is a toast.
  const chat = useChat(roomId, chatSocket, (message) =>
    toast(t('chat.mentionToast', { name: message.authorName })),
  );
  // The socket's settings follow room.updated; until it opens, the REST answer.
  const known = state.settings ?? room.data?.effectiveSettings;
  const capabilities = capabilitiesOf(known);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { watch: watchParam } = useSearch({ strict: false });
  const watch = capabilities.stream ? watchParam : undefined;
  const [theater, setTheater] = useState(false);
  // Development builds can use fake media instead of the SFU.
  const [fake] = useState(fakeMediaEnabled);
  const rtc = { session: session.parts.rtc, status: rtcStatus };
  const layout = useBreakpoint();
  // The chat slide-over below 1024 px; the chat side panel on desktop (shown by default).
  const [chatOpen, setChatOpen] = useState(false);
  const [chatShown, setChatShown] = useState(true);
  // The Go live panel, opened from the control bar and brought into view.
  const [goLiveOpen, setGoLiveOpen] = useState(false);
  const goLiveRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (goLiveOpen) goLiveRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [goLiveOpen]);
  const liveNow = useLiveHere(roomId);
  // Pull on hover (rtc/prepull.ts): behind the `prepull` flag, desktop pointers only.
  const [prepull] = useState(() => !fake && prepullEnabled() && canHover());
  const { watch: watchSlot, unwatch: unwatchSlot } = actions;
  const prepuller = useMemo(
    () => (prepull ? new PrePuller(rtc.session, { watch: watchSlot, unwatch: unwatchSlot }) : null),
    [prepull, rtc.session, watchSlot, unwatchSlot],
  );
  useEffect(() => () => prepuller?.dispose(), [prepuller]);
  // The watch view may take over a slot that is already granted (a pre-pull): see deferUnwatch.
  const watchActions = useMemo(
    () => (prepull ? deferUnwatch(actions) : actions),
    [prepull, actions],
  );
  useEffect(() => prepuller?.sync(state.access), [prepuller, state.access]);
  const mediaFactory = useMemo(
    () => (fake ? fakeMediaFactory : rtcMediaFactory(rtc.session, prepuller)),
    [fake, rtc.session, prepuller],
  );
  const hoverStream = (streamId: string, hovering: boolean) => {
    if (!prepuller || streamId === watch) return;
    const stream = state.streams.find((s) => s.streamId === streamId);
    if (!hovering) prepuller.leave(streamId);
    else if (stream) prepuller.hover(stream, state.access[streamId]);
  };
  const openStream = (streamId: string | null) => {
    if (streamId !== null) {
      markWatchStart(streamId);
      prepuller?.claim(streamId);
    }
    void navigate({
      to: '.',
      search: (prev) => ({ ...prev, watch: streamId ?? undefined }),
      replace: streamId === null,
    });
  };
  useTutorialScreen('room', room.isSuccess);

  // Kicked or closed: what the REST lists show changed too.
  useEffect(() => {
    if (state.ended?.kind === 'kicked' || state.ended?.kind === 'closed') {
      void queryClient.invalidateQueries({ queryKey: ['space'] });
      void queryClient.invalidateQueries({ queryKey: spaceKeys.room(roomId) });
      void queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    }
  }, [state.ended, queryClient, roomId]);

  // Spaces › <Space> › <Room> [› <Streamer>]. A member who opened the room by id still gets the
  // space from their memberships; the room crumb stays on the current URL so the socket survives.
  const trailSpace =
    space ?? me.data?.memberships.find((m) => m.spaceId === room.data?.spaceId) ?? null;
  const streamer =
    watch === undefined
      ? undefined
      : {
          name:
            state.status === 'connecting'
              ? undefined
              : (streamCards(state, t('player.someone')).find((card) => card.id === watch)?.name ??
                t('player.someone')),
        };
  const trail = roomTrail(
    t,
    trailSpace,
    { name: state.room?.name ?? room.data?.name, link: roomLink(space, room.data, roomId) },
    streamer,
  );

  if (room.isPending) {
    return (
      <Page title={state.room?.name ?? t('room.loading')} breadcrumbs={trail}>
        <Skeleton className="h-40 w-full" />
      </Page>
    );
  }
  if (room.isError && !state.room) {
    return (
      <Page title={t('room.loading')} breadcrumbs={trail}>
        <QueryError error={room.error} onRetry={() => void room.refetch()} />
      </Page>
    );
  }
  const info = room.data;
  const name = state.room?.name ?? info?.name ?? '';
  const selfId = me.data?.user.id ?? '';
  const role = state.you?.role ?? space?.role ?? null;
  const manage = info && state.status !== 'ended' ? canManageRoom(role, selfId, info) : false;
  const expiresAt = state.expiresAt ?? info?.expiresAt ?? null;
  const people: VoicePeopleProps = {
    participants: state.voice.participants,
    members: state.members,
    selfId,
    client: voice.client,
    state: voice.state,
    moderator: state.you?.permissions.canModerate ? { role } : null,
    moderation,
  };
  const canJoinVoice = state.status === 'open' && canJoinVoiceOf(state.you);
  const cameraBar: CameraBarProps | null =
    capabilities.voice && capabilities.camera
      ? {
          client: camera.client,
          state: camera.state,
          allowed: state.you?.permissions.canUseCamera === true,
        }
      : null;
  const chatProps = {
    client: chat.client,
    state: chat.state,
    you: state.you,
    members: state.members,
    settings: known ?? null,
    quick: info?.kind === 'quick',
    online: state.status === 'open',
  };
  // The chat beside the stage: a panel on the right on desktop (open by default, the chat button
  // hides it), a slide-over below 1024 px. A text-only room's page is the chat.
  const sideChat = capabilities.text && (capabilities.stream || capabilities.voice);
  const chatPanelShown = sideChat && layout === 'desktop' && chatShown && !(watch && theater);
  const hasStage = capabilities.stream || capabilities.voice;
  const canGoLive = capabilities.stream && state.status === 'open' && !liveNow;
  const joined = voice.state.phase === 'joined';
  const titleActions = (
    <RoomTitleActions
      goLive={canGoLive ? () => setGoLiveOpen(true) : null}
      chat={
        sideChat
          ? {
              unread: chat.state.unread,
              open: layout === 'desktop' ? chatPanelShown : chatOpen,
              onToggle: () =>
                layout === 'desktop' ? setChatShown((shown) => !shown) : setChatOpen(true),
            }
          : null
      }
      tourChat={!chatPanelShown}
    />
  );
  // Out of voice, Join voice: in the empty stage, else under the tiles. Once in, the app's
  // "Voice connected" panel (the sidebar's footer, the bottom bar on phones) has the controls.
  const join =
    capabilities.voice && !joined ? (
      <JoinVoiceButton
        client={voice.client}
        state={voice.state}
        canJoin={canJoinVoice}
        onJoin={joinVoice}
      />
    ) : null;
  const streams = capabilities.stream ? streamCards(state, t('player.someone')) : [];
  const stageEmpty =
    streams.length === 0 && (!capabilities.voice || people.participants.length === 0);

  return (
    <Page
      title={name}
      titleActions={titleActions}
      breadcrumbs={trail}
      fill
      description={
        info?.kind === 'quick'
          ? t('room.quickIntro', { code: quickCode(info) })
          : capabilities.stream
            ? t('room.intro')
            : t(`room.layout.${channelKind(capabilities)}.description`)
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <PresenceButton state={state} selfId={selfId} />
          {info?.code && state.status !== 'ended' && <RoomCode code={info.code} />}
          {expiresAt !== null && (
            <Badge variant="outline">
              <Countdown expiresAt={expiresAt} />
            </Badge>
          )}
          {info && manage && isManager(role) && (
            <RoomFeaturesDialog
              key={JSON.stringify(info.settings.capabilities)}
              room={info}
              space={space}
              liveStreams={state.streams.length}
            />
          )}
          {info && manage && info.visibility === 'restricted' && <RoomAccessDialog room={info} />}
          {info && manage && <ArchiveRoomButton room={info} space={space} />}
        </div>
      }
    >
      <ConnectionBanner state={state} reconnect={reconnect} space={space} />
      {/* The stage (streams and people as tiles, or the one being watched big) on the left and
          the chat on the right on desktop; one column below 1024 px. The page is as tall as the
          screen: the stage scrolls inside its column and the chat's messages inside the chat, so
          the page itself never grows. The main column and the player in it keep their place in
          the tree at every width, so a resize or a phone turned sideways does not reconnect the
          stream. */}
      <div
        className={cn(
          'grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-6',
          chatPanelShown && 'grid-cols-[minmax(0,1fr)_22.5rem]',
        )}
        data-layout={layout}
        data-testid="room-body"
      >
        <div
          className="flex min-h-0 min-w-0 flex-col gap-3"
          data-testid="room-main"
          data-rtc={fake ? 'fake' : rtc.status}
        >
          <div
            className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-1"
            data-testid="room-scroll"
          >
            {hasStage ? (
              <RoomStage
                streams={streams}
                people={capabilities.voice ? people : null}
                cameras={cameraBar ? { client: camera.client, state: camera.state } : null}
                focusId={watch ?? null}
                focus={
                  watch ? (
                    <MediaFactoryContext value={mediaFactory}>
                      <WatchPanel
                        key={watch}
                        roomId={roomId}
                        state={state}
                        streamId={watch}
                        actions={watchActions}
                        theater={theater}
                        onTheaterChange={setTheater}
                        onClose={() => openStream(null)}
                        pointer={pointer}
                      />
                    </MediaFactoryContext>
                  ) : null
                }
                large={!capabilities.stream}
                onWatch={openStream}
                onHover={prepuller ? hoverStream : undefined}
                empty={
                  capabilities.stream
                    ? {
                        title: t('room.empty.title'),
                        description: t(
                          capabilities.voice ? 'room.stage.emptyBoth' : 'room.empty.description',
                        ),
                      }
                    : { title: t('room.stage.emptyVoice'), description: t('room.stage.joinHint') }
                }
                emptyAction={stageEmpty ? join : null}
              />
            ) : capabilities.text ? (
              <ChatPanel {...chatProps} variant="page" className="h-auto min-h-0 flex-1" />
            ) : (
              <ChannelLayout kind={channelKind(capabilities)} state={state} />
            )}
            {/* The Go live panel opens from the header; while live, the live controls. */}
            {capabilities.stream && state.status === 'open' && (
              <div ref={goLiveRef} className="empty:hidden">
                <GoLiveArea
                  roomId={roomId}
                  settings={state.settings}
                  canStream={state.you?.permissions.canStream ?? false}
                  open={goLiveOpen}
                  onOpenChange={setGoLiveOpen}
                  pings={{ streams: state.streams, selfId: state.you?.userId ?? '', pointer }}
                />
              </div>
            )}
          </div>
          {/* Join voice under the tiles, always in sight. */}
          {join && !stageEmpty && <div className="flex shrink-0 justify-center">{join}</div>}
          {/* What is going on in voice: the status line, "you're on camera", the notices. */}
          {capabilities.voice && (
            <VoiceBar
              client={voice.client}
              state={voice.state}
              canJoin={canJoinVoice}
              camera={cameraBar}
              onJoin={joinVoice}
              docked
              className="max-h-[40%] shrink-0 overflow-y-auto"
            />
          )}
        </div>
        {chatPanelShown && (
          <aside className="flex min-h-0 min-w-0 flex-col" aria-label={t('chat.title')}>
            <ChatPanel
              {...chatProps}
              variant="panel"
              className="h-auto min-h-0 flex-1"
              onClose={() => setChatShown(false)}
            />
          </aside>
        )}
      </div>
      {/* Phones: the bottom bar is the "Voice connected" panel while in voice (BottomBars). */}
      {layout === 'mobile' && <BottomBars />}
      {sideChat && layout !== 'desktop' && (
        <ChatSlideOver open={chatOpen} onOpenChange={setChatOpen}>
          <ChatPanel {...chatProps} variant="sheet" onClose={() => setChatOpen(false)} />
        </ChatSlideOver>
      )}
    </Page>
  );
}

/** The room's page: by slugs in its space, else by id. */
function roomLink(space: Space | null, room: Room | undefined, roomId: string): RoomLink {
  return space && room
    ? { to: '/s/$spaceSlug/r/$roomSlug', params: { spaceSlug: space.slug, roomSlug: room.slug } }
    : { to: '/rooms/$roomId', params: { roomId } };
}

type ChannelKind = 'voice' | 'text' | 'none';
const VOICE = 'voice';
const TEXT = 'text';

/** What a room without stream or voice shows: the chat, else nothing usable. */
const channelKind = (c: RoomCapabilities): ChannelKind =>
  c.voice ? VOICE : c.text ? TEXT : 'none';

const PANEL_ICONS: Record<ChannelKind, Icon> = {
  voice: MicrophoneIcon,
  text: ChatsIcon,
  none: ProhibitIcon,
};

/** Permissions.canJoinVoice (protocol 1.10); an older server leaves it out. */
const canJoinVoiceOf = (you: You | null): boolean =>
  you !== null && you.permissions.canJoinVoice !== false;

/**
 * When the space or the platform no longer allows anything the room has: an explanation.
 */
function ChannelLayout({ kind }: { kind: ChannelKind; state: RoomState }) {
  const { t } = useTranslation();
  const LayoutIcon = PANEL_ICONS[kind];
  return (
    <section
      className="flex min-h-64 flex-col items-center justify-center gap-4 rounded-xl border border-dashed p-6 text-center"
      aria-labelledby="room-channel"
      data-testid={`room-layout-${kind}`}
    >
      <LayoutIcon className="size-8 text-muted-foreground" aria-hidden />
      <div className="flex flex-col items-center gap-1">
        <h2 id="room-channel" className="flex items-center gap-2 text-lg font-semibold">
          {t(`room.layout.${kind}.title`)}
        </h2>
        <p className="max-w-prose text-[0.9375rem] text-muted-foreground">
          {t(`room.layout.${kind}.description`)}
        </p>
      </div>
    </section>
  );
}

/** Connecting, reconnecting and every way the connection can end (PROTOCOL 5). */
function ConnectionBanner({
  state,
  reconnect,
  space,
}: {
  state: RoomState;
  reconnect: () => void;
  space: Space | null;
}) {
  const { t } = useTranslation();
  if (state.status === 'connecting') {
    return (
      <Alert>
        <Spinner aria-hidden />
        <AlertTitle>{t('room.connection.connecting')}</AlertTitle>
      </Alert>
    );
  }
  if (state.status === 'reconnecting') {
    return (
      <Alert>
        <WifiSlashIcon />
        <AlertTitle>
          {state.quotaExceeded
            ? t('room.connection.quotaExceeded')
            : t('room.connection.reconnecting')}
        </AlertTitle>
        <AlertDescription>
          {state.quotaExceeded
            ? t('room.connection.quotaExceededHint')
            : t('room.connection.reconnectingHint')}
        </AlertDescription>
        <AlertAction>
          <Button variant="outline" onClick={reconnect}>
            {t('room.connection.retryNow')}
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (state.status !== 'ended' || !state.ended) return null;
  const ended = state.ended;
  const toSpaces = (
    <Button variant="outline" asChild>
      <Link to="/spaces">{t('invite.toSpaces')}</Link>
    </Button>
  );
  const back = space ? (
    <Button variant="outline" asChild>
      <Link to="/s/$spaceSlug" params={{ spaceSlug: space.slug }}>
        {t('room.backToSpace', { space: space.name })}
      </Link>
    </Button>
  ) : (
    toSpaces
  );
  switch (ended.kind) {
    case 'replaced':
      return (
        <Alert>
          <PlugsIcon />
          <AlertTitle>{t('room.connection.replaced')}</AlertTitle>
          <AlertDescription>{t('room.connection.replacedHint')}</AlertDescription>
          <AlertAction>
            <Button variant="outline" onClick={reconnect}>
              {t('room.connection.useHere')}
            </Button>
          </AlertAction>
        </Alert>
      );
    case 'reload':
      return (
        <Alert variant="destructive">
          <ArrowClockwiseIcon />
          <AlertTitle>{t('room.connection.reload')}</AlertTitle>
          <AlertDescription>{t('errors.protocol_unsupported')}</AlertDescription>
          <AlertAction>
            <Button variant="outline" onClick={() => window.location.reload()}>
              {t('room.connection.reloadAction')}
            </Button>
          </AlertAction>
        </Alert>
      );
    case 'kicked':
      return (
        <Alert variant="destructive">
          <SignOutIcon />
          <AlertTitle>{t('room.connection.kicked')}</AlertTitle>
          <AlertDescription>{t(`room.kickReason.${ended.reason}`)}</AlertDescription>
          {/* The space may be out of reach now (removed, banned). */}
          <AlertAction>{toSpaces}</AlertAction>
        </Alert>
      );
    case 'closed':
      return (
        <Alert>
          <ArchiveIcon />
          <AlertTitle>{t('room.connection.closed')}</AlertTitle>
          <AlertDescription>{t(`room.closeReason.${ended.reason}`)}</AlertDescription>
          <AlertAction>{back}</AlertAction>
        </Alert>
      );
    case 'forbidden':
    case 'unauthenticated':
      return (
        <Alert variant="destructive">
          <SignOutIcon />
          <AlertTitle>{t('room.connection.noAccess')}</AlertTitle>
          <AlertDescription>
            {t(ended.kind === 'forbidden' ? 'errors.forbidden' : 'errors.unauthenticated')}
          </AlertDescription>
          <AlertAction>{back}</AlertAction>
        </Alert>
      );
  }
}

function ArchiveRoomButton({ room, space }: { room: Room; space: Space | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const archive = useArchiveRoom(room);
  const kind = room.kind === 'quick' ? 'end' : 'archive';
  const leave = () =>
    void navigate(
      space ? { to: '/s/$spaceSlug', params: { spaceSlug: space.slug } } : { to: '/spaces' },
    );
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline">
          <ArchiveIcon data-icon="inline-start" />
          {t(`room.${kind}.action`)}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{t(`room.${kind}.title`, { name: room.name })}</AlertDialogTitle>
          <AlertDialogDescription>{t(`room.${kind}.description`)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              archive.mutate(undefined, {
                onSuccess: leave,
                onError: (error) => toast.error(translateError(errorBodyOf(error), t)),
              })
            }
          >
            {t(`room.${kind}.action`)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
