// SPDX-License-Identifier: AGPL-3.0-only
import {
  BroadcastIcon,
  ChatsIcon,
  type Icon,
  LightningIcon,
  MicrophoneSlashIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
} from '@phosphor-icons/react';
import type { RoomPresence } from '@openlive/protocol';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { type Membership, meQuery } from '../api/auth.ts';
import { type Room, roomsQuery } from '../api/spaces.ts';
import { unreadLabel, useChatUnread } from '../chat/api.ts';
import { capabilitiesOf } from '../lib/capabilities.ts';
import { useSpacePresence } from '../space/use-space-presence.ts';

// The rooms of the space being browsed, in the app sidebar: one row per room with its kind and
// unread chat, the current one marked, and under it who is in the room's voice (mute and deafen
// icons) and LIVE next to whoever streams, from the space's presence socket (PROTOCOL.md 7.8).

/** Someone in a room's voice, as the sidebar shows them. */
export interface SidebarVoicePerson {
  userId: string;
  name: string;
  avatarUrl?: string | undefined;
  speaking?: boolean;
  muted?: boolean;
  deafened?: boolean;
  /** Streams in the room now. */
  live?: boolean;
}

/** People shown under a room before "+k more". */
export const SIDEBAR_PEOPLE_MAX = 5;

/**
 * The sidebar's people of a room: everyone in voice in the order they joined, then streamers who
 * are not in voice; LIVE on whoever streams.
 */
export function sidebarPeople(room: RoomPresence | undefined): SidebarVoicePerson[] {
  if (!room) return [];
  const streaming = new Set(room.live.map((l) => l.userId));
  const people: SidebarVoicePerson[] = room.voice.map((v) => ({
    userId: v.userId,
    name: v.displayName,
    avatarUrl: v.avatarUrl,
    muted: v.muted,
    deafened: v.deafened,
    live: streaming.has(v.userId),
  }));
  const inVoice = new Set(people.map((p) => p.userId));
  for (const l of room.live) {
    if (inVoice.has(l.userId)) continue;
    inVoice.add(l.userId);
    people.push({
      userId: l.userId,
      name: l.displayName ?? '?',
      avatarUrl: l.avatarUrl,
      live: true,
    });
  }
  return people;
}

type RoomIconKind = 'quick' | 'stream' | 'voice' | 'text';

const ROOM_ICONS: Record<RoomIconKind, Icon> = {
  quick: LightningIcon,
  stream: BroadcastIcon,
  voice: SpeakerHighIcon,
  text: ChatsIcon,
};

/** What the room's icon says: stream first, then voice, then text; quick rooms their own. */
function roomIconKind(room: Room): RoomIconKind {
  if (room.kind === 'quick') return 'quick';
  const c = capabilitiesOf(room.effectiveSettings);
  return c.stream ? 'stream' : c.voice ? 'voice' : 'text';
}

export function SidebarRoomRow({
  room,
  spaceSlug,
  active,
  unread,
  presence,
  onNavigate,
}: {
  room: Room;
  spaceSlug: string;
  active: boolean;
  unread: number;
  /** Who is in the room's voice or streams there (sidebarPeople). */
  presence?: readonly SidebarVoicePerson[];
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const RoomIcon = ROOM_ICONS[roomIconKind(room)];
  return (
    <SidebarMenuItem data-testid="sidebar-room" data-room={room.id}>
      <SidebarMenuButton asChild isActive={active}>
        <Link
          to="/s/$spaceSlug/r/$roomSlug"
          params={{ spaceSlug, roomSlug: room.slug }}
          onClick={onNavigate}
        >
          <RoomIcon />
          <span>{room.name}</span>
        </Link>
      </SidebarMenuButton>
      {unread > 0 && (
        <SidebarMenuBadge aria-label={t('chat.unread', { count: unread })}>
          {unreadLabel(unread)}
        </SidebarMenuBadge>
      )}
      {presence && presence.length > 0 && (
        <ul
          className="flex flex-col gap-1 py-1 pl-8"
          aria-label={t('voice.inVoice', { count: presence.length })}
          data-testid="sidebar-room-people"
        >
          {presence.slice(0, SIDEBAR_PEOPLE_MAX).map((person) => (
            <li key={person.userId} className="flex items-center gap-2 text-[0.8125rem]">
              <Avatar
                size="sm"
                className={cn(
                  'ring-offset-1 ring-offset-sidebar',
                  person.speaking && 'ring-2 ring-primary',
                )}
              >
                {person.avatarUrl && <AvatarImage src={person.avatarUrl} alt="" />}
                <AvatarFallback>{person.name.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate">{person.name}</span>
              {person.deafened ? (
                <SpeakerSlashIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  role="img"
                  aria-label={t('voice.state.deafened')}
                />
              ) : (
                person.muted && (
                  <MicrophoneSlashIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    role="img"
                    aria-label={t('voice.state.muted')}
                  />
                )
              )}
              {person.live && (
                <span className="rounded-sm bg-live px-1 text-xs font-medium text-live-foreground">
                  {t('stream.status.live')}
                </span>
              )}
            </li>
          ))}
          {presence.length > SIDEBAR_PEOPLE_MAX && (
            <li className="text-xs text-muted-foreground">
              {t('app.sidebar.morePeople', { count: presence.length - SIDEBAR_PEOPLE_MAX })}
            </li>
          )}
        </ul>
      )}
    </SidebarMenuItem>
  );
}

/** The space in the current URL (/s/<slug>/…), among the user's memberships. */
function spaceSlugOf(pathname: string): string | null {
  return /^\/s\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

export function SidebarRooms({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate: () => void;
}) {
  const me = useQuery(meQuery);
  const slug = spaceSlugOf(pathname);
  const space = slug ? me.data?.memberships.find((m) => m.slug === slug) : undefined;
  if (!space) return null;
  return <SpaceRooms space={space} pathname={pathname} onNavigate={onNavigate} />;
}

function SpaceRooms({
  space,
  pathname,
  onNavigate,
}: {
  space: Membership;
  pathname: string;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const rooms = useQuery(roomsQuery(space.spaceId));
  const unread = useChatUnread(space.spaceId);
  const presence = useSpacePresence(space.spaceId);
  if (!rooms.data || rooms.data.length === 0) return null;
  const label = t('app.sidebar.rooms', { space: space.name });
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <nav aria-label={label}>
        <SidebarMenu>
          {rooms.data.map((room) => (
            <SidebarRoomRow
              key={room.id}
              room={room}
              spaceSlug={space.slug}
              active={pathname.startsWith(`/s/${space.slug}/r/${room.slug}`)}
              unread={unread[room.id] ?? 0}
              presence={sidebarPeople(presence[room.id])}
              onNavigate={onNavigate}
            />
          ))}
        </SidebarMenu>
      </nav>
    </SidebarGroup>
  );
}
