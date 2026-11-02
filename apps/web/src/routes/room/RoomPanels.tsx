// SPDX-License-Identifier: AGPL-3.0-only
import { BroadcastIcon, ChatsIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { unreadLabel } from '../../chat/api.ts';
import type { RoomState } from '../../room/connection.ts';
import { MemberAvatar } from '../space/MembersTab.tsx';

// The pieces of the room page (RoomView) around the stage (RoomStage.tsx): who is here, Go live
// and the chat next to the room's name, and the chat slide-over below 1024 px.

/** How many faces the "N here" button shows before the count. */
const FACES = 3;

/** "3 here" with a few faces; opens the list of everyone in the room with their roles. */
export function PresenceButton({ state, selfId }: { state: RoomState; selfId: string }) {
  const { t } = useTranslation();
  const label =
    state.status === 'open'
      ? t('room.present.title', { count: state.members.length })
      : t('room.present.titleNoCount');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" data-tour="room-presence">
          {state.members.length > 0 && (
            <span className="flex -space-x-1" aria-hidden>
              {state.members.slice(0, FACES).map((m) => (
                <Avatar key={m.userId} size="sm" className="ring-2 ring-card">
                  {m.avatarUrl && <AvatarImage src={m.avatarUrl} alt="" />}
                  <AvatarFallback>{m.displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
                </Avatar>
              ))}
            </span>
          )}
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        {state.status === 'connecting' ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : state.members.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">{t('room.present.empty')}</p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto" aria-live="polite">
            {state.members.map((member) => (
              <li key={member.userId} className="flex items-center gap-2">
                <MemberAvatar name={member.displayName} avatarUrl={member.avatarUrl} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[0.9375rem]">
                    {member.displayName}
                    {member.userId === selfId && (
                      <span className="text-muted-foreground"> {t('space.members.you')}</span>
                    )}
                  </span>
                  <span className="text-[0.8125rem] text-muted-foreground">
                    {t(`roles.${member.role}`)}
                    {member.role === 'guest' &&
                      member.canStream &&
                      ` · ${t('room.present.canStream')}`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Go live (rooms with stream) and the chat with its unread count (the chat beside streams or
 * voice), as icon buttons next to the room's name. The voice controls are the app's "Voice
 * connected" panel (VoiceConnected.tsx), not here.
 */
export function RoomTitleActions({
  goLive,
  chat,
  tourChat,
}: {
  /** Opens the Go live panel; null while live or without stream. */
  goLive: (() => void) | null;
  /** The chat toggle: pressed while the side panel shows (desktop). */
  chat: { unread: number; open: boolean; onToggle: () => void } | null;
  /** The tutorial's chat-button step points at the button (the chat is not on screen). */
  tourChat: boolean;
}) {
  const { t } = useTranslation();
  if (!goLive && !chat) return null;
  return (
    <div className="flex items-center gap-1" data-testid="room-title-actions">
      {goLive && (
        // Primary, like "Join voice": going live is one of the room's two main actions. The label
        // collapses to the icon on phones, where the header is narrow.
        <Button
          size="sm"
          onClick={goLive}
          title={t('golive.action')}
          data-tour="room-go-live"
          data-testid="go-live"
        >
          <BroadcastIcon data-icon="inline-start" />
          <span className="max-sm:sr-only">{t('golive.action')}</span>
        </Button>
      )}
      {chat && (
        <Button
          variant={chat.open ? 'secondary' : 'ghost'}
          size="icon"
          aria-pressed={chat.open}
          aria-label={
            chat.unread > 0
              ? `${t('chat.title')} (${t('chat.unread', { count: chat.unread })})`
              : t('chat.title')
          }
          title={t('chat.title')}
          onClick={chat.onToggle}
          className="relative"
          data-testid="chat-toggle"
          data-tour={tourChat ? 'room-chat-toggle' : undefined}
        >
          <ChatsIcon />
          {chat.unread > 0 && (
            <Badge
              className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[0.625rem]"
              aria-hidden
              data-testid="chat-unread"
            >
              {unreadLabel(chat.unread)}
            </Badge>
          )}
        </Button>
      )}
    </div>
  );
}

/**
 * The chat over the page below 1024 px: full screen on phones, a panel from the right on
 * tablets. A focus-trapped dialog; Escape or the close button in the chat header closes it.
 */
export function ChatSlideOver({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        className="gap-0 pb-[env(safe-area-inset-bottom)] data-[side=right]:w-full data-[side=right]:border-l-0 data-[side=right]:sm:max-w-none data-[side=right]:md:w-[22.5rem] data-[side=right]:md:border-l data-[side=right]:md:max-w-[22.5rem]"
        data-testid="chat-slide-over"
      >
        <SheetTitle className="sr-only">{t('chat.title')}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
