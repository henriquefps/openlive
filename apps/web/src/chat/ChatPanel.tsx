// SPDX-License-Identifier: AGPL-3.0-only
import {
  ArrowClockwiseIcon,
  ChatsIcon,
  DotsThreeIcon,
  PaperPlaneRightIcon,
  PencilSimpleIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react';
import type { Member, Role, RoomSettings, You } from '@openlive/protocol';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { TFunction } from 'i18next';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { translateError } from '../i18n/errors.ts';
import { formatDate } from '../i18n/format.ts';
import { MemberAvatar } from '../routes/space/MembersTab.tsx';
import { unreadLabel } from './api.ts';
import {
  CHAT_MAX_CHARS,
  type ChatClient,
  type ChatEntry,
  type ChatState,
  charCount,
} from './client.ts';
import { mentionQuery, segments } from './text.ts';

// The room's text chat: a panel beside the streams or voice, or
// the whole page of a text channel. Messages are plain text: links and mentions become elements
// built here, never HTML from the message (chat/text.ts).

/** Someone the reader can mention or knows by name. */
interface Person {
  userId: string;
  name: string;
  avatarUrl?: string;
}

export interface ChatPanelProps {
  client: ChatClient;
  state: ChatState;
  you: You | null;
  /** Present members (mention suggestions, names, roles for moderation). */
  members: Member[];
  settings: RoomSettings | null;
  /** A quick room's chat ends with the room, whatever the retention says. */
  quick: boolean;
  /** The room socket is open. */
  online: boolean;
  /**
   * `page`: the whole page of a text channel; `panel`: a card beside streams or voice; `sheet`:
   * the content of the chat slide-over (phones, tablets), filling it.
   */
  variant: 'panel' | 'page' | 'sheet';
  className?: string | undefined;
  /** A close button in the header (the chat side panel, the slide-over). */
  onClose?: (() => void) | undefined;
}

/** Messages within this much of the bottom count as "at the bottom" (new ones scroll in). */
const STICK_PX = 80;
const MAX_SUGGESTIONS = 6;
const GUEST: Role = 'guest';
const MEMBER: Role = 'member';
const AUTOCOMPLETE = 'list';

export function ChatPanel({
  client,
  state,
  you,
  members,
  settings,
  quick,
  online,
  variant,
  className,
  onClose,
}: ChatPanelProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const canWrite = online && you?.permissions.canWriteChat !== false;
  const selfId = you?.userId ?? null;
  const people = usePeople(members, state.messages);
  const roles = useMemo(() => new Map(members.map((m) => [m.userId, m.role])), [members]);
  const section = useRef<HTMLElement>(null);
  useActive(client, section);

  // A refused edit or delete: a toast, then forget it.
  useEffect(() => {
    if (!state.error) return;
    toast.error(translateError(state.error, t));
    client.clearError();
  }, [state.error, client, t]);

  const retention = retentionText(t, settings?.chatRetentionDays, quick);
  return (
    <section
      ref={section}
      aria-labelledby={titleId}
      data-testid={`chat-${variant}`}
      // In the slide-over the tutorial points at the chat button instead.
      data-tour={variant === 'sheet' ? undefined : 'room-chat'}
      className={cn(
        'flex min-h-0 flex-col bg-card',
        variant === 'sheet' ? 'flex-1' : 'rounded-xl border',
        variant === 'page' && 'h-[min(70dvh,48rem)]',
        variant === 'panel' && 'h-[min(60dvh,36rem)]',
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <ChatsIcon aria-hidden />
        <h2 id={titleId} className="font-semibold">
          {t('chat.title')}
        </h2>
        {state.unread > 0 && (
          <Badge aria-label={t('chat.unread', { count: state.unread })}>
            {unreadLabel(state.unread)}
          </Badge>
        )}
        <span className="ml-auto truncate text-[0.8125rem] text-muted-foreground">{retention}</span>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="-mr-2 shrink-0"
            onClick={onClose}
            aria-label={t('chat.close')}
          >
            <XIcon />
          </Button>
        )}
      </header>
      <MessageList
        client={client}
        state={state}
        selfId={selfId}
        you={you}
        roles={roles}
        people={people}
      />
      {canWrite ? (
        <Composer client={client} people={people} selfId={selfId} />
      ) : (
        <p className="border-t px-4 py-3 text-[0.8125rem] text-muted-foreground">
          {online ? t('chat.readOnly') : t('chat.offline')}
        </p>
      )}
    </section>
  );
}

/** "Messages kept 30 days" and the like, for the header and the room settings. */
export function retentionText(t: TFunction, days: number | undefined, quick: boolean): string {
  if (quick) return t('chat.retention.quick');
  if (days === 0) return t('chat.retention.none');
  return t('chat.retention.days', { count: days ?? 30 });
}

/** Present members, then everyone who wrote, by user id. */
function usePeople(members: Member[], messages: ChatEntry[]): Person[] {
  return useMemo(() => {
    const byId = new Map<string, Person>();
    for (const m of members) {
      byId.set(m.userId, {
        userId: m.userId,
        name: m.displayName,
        ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
      });
    }
    for (const m of messages) {
      if (m.userId && m.authorName && !byId.has(m.userId)) {
        byId.set(m.userId, { userId: m.userId, name: m.authorName });
      }
    }
    return [...byId.values()];
  }, [members, messages]);
}

/**
 * Tells the client whether the reader sees the newest messages: the panel is on screen (not in
 * a hidden tab) and the window is visible and focused.
 */
function useActive(client: ChatClient, section: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const panel = section.current;
    let onScreen = true;
    const update = () =>
      client.setActive(onScreen && document.visibilityState === 'visible' && document.hasFocus());
    const observer =
      panel && typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((entries) => {
            onScreen = entries.some((e) => e.isIntersecting);
            update();
          })
        : null;
    if (panel) observer?.observe(panel);
    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
      client.setActive(false);
    };
  }, [client, section]);
}

function MessageList({
  client,
  state,
  selfId,
  you,
  roles,
  people,
}: {
  client: ChatClient;
  state: ChatState;
  selfId: string | null;
  you: You | null;
  roles: Map<string, Role>;
  people: Person[];
}) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const firstId = useRef<string | null>(null);
  const height = useRef(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ChatEntry | null>(null);

  // Infinite scroll: the sentinel at the top loads the page before.
  useEffect(() => {
    const el = top.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) client.loadOlder();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [client, state.status]);

  // Older messages above keep the view where it was; new ones scroll in while at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = state.messages[0]?.id ?? null;
    if (firstId.current !== null && first !== firstId.current && height.current > 0) {
      el.scrollTop += el.scrollHeight - height.current;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    firstId.current = first;
    height.current = el.scrollHeight;
  }, [state.messages]);

  const mentionNames = (ids: string[]) =>
    ids.flatMap((id) => {
      const person = people.find((p) => p.userId === id);
      return person ? [{ userId: id, name: person.name }] : [];
    });

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        height.current = el.scrollHeight;
      }}
    >
      <div ref={top} aria-hidden className="h-px" />
      {state.loadingOlder && (
        <div className="flex justify-center py-2">
          <Spinner aria-label={t('chat.loadingOlder')} />
        </div>
      )}
      {state.status === 'loading' ? (
        <div className="flex flex-col gap-3 p-2">
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="h-10 w-2/3" />
        </div>
      ) : state.messages.length === 0 ? (
        <p className="p-4 text-center text-[0.9375rem] text-muted-foreground">{t('chat.empty')}</p>
      ) : (
        <ol role="log" aria-live="polite" aria-label={t('chat.title')} className="flex flex-col">
          {state.messages.map((message, i) => {
            const previous = state.messages[i - 1];
            const grouped =
              previous !== undefined &&
              previous.userId === message.userId &&
              message.createdAt - previous.createdAt < 5 * 60_000;
            const own = message.userId !== undefined && message.userId === selfId;
            // A removed account counts as a guest; someone not here now, as a member.
            const authorRole: Role =
              message.userId === undefined ? GUEST : (roles.get(message.userId) ?? MEMBER);
            const moderate =
              !own &&
              you !== null &&
              you.permissions.canModerate &&
              mayDeleteOthers(you.role, authorRole);
            return (
              <MessageItem
                key={message.clientId ?? message.id}
                message={message}
                grouped={grouped}
                own={own}
                mentioned={selfId !== null && message.mentions.includes(selfId)}
                mentions={mentionNames(message.mentions)}
                avatarUrl={people.find((p) => p.userId === message.userId)?.avatarUrl}
                editing={editing === message.id}
                onEdit={own ? () => setEditing(message.id) : undefined}
                onDelete={own || moderate ? () => setDeleting(message) : undefined}
                onSave={(text) => {
                  if (text.trim() !== message.text) client.edit(message.id, text);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
                onRetry={() => message.clientId && client.retry(message.clientId)}
                onDiscard={() => message.clientId && client.discard(message.clientId)}
              />
            );
          })}
        </ol>
      )}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chat.delete.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.userId === selfId ? t('chat.delete.own') : t('chat.delete.other')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) client.delete(deleting.id);
                setDeleting(null);
              }}
            >
              {t('chat.delete.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The removal rule (can() chat.delete): owners delete anyone's, admins members' and guests'. */
export const mayDeleteOthers = (role: Role, authorRole: Role): boolean =>
  role === 'owner' || (role === 'admin' && authorRole !== 'owner' && authorRole !== 'admin');

function MessageItem({
  message,
  grouped,
  own,
  mentioned,
  mentions,
  avatarUrl,
  editing,
  onEdit,
  onDelete,
  onSave,
  onCancel,
  onRetry,
  onDiscard,
}: {
  message: ChatEntry;
  grouped: boolean;
  own: boolean;
  mentioned: boolean;
  mentions: { userId: string; name: string }[];
  avatarUrl: string | undefined;
  editing: boolean;
  onEdit: (() => void) | undefined;
  onDelete: (() => void) | undefined;
  onSave: (text: string) => void;
  onCancel: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const removed = message.userId === undefined;
  const name = removed ? t('chat.accountRemoved') : message.authorName;
  const time = formatDate(message.createdAt, locale, { timeStyle: 'short' });
  const full = formatDate(message.createdAt, locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <li
      className={cn(
        'group relative flex gap-2 rounded-md px-2 py-1 hover:bg-muted/50',
        !grouped && 'mt-2',
        mentioned && 'bg-primary/5',
        message.pending && 'opacity-60',
      )}
      data-testid="chat-message"
      aria-busy={message.pending ? true : undefined}
    >
      <div className="w-8 shrink-0">
        {!grouped && <MemberAvatar name={name || '?'} avatarUrl={avatarUrl} size="sm" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className={cn('truncate text-[0.875rem] font-semibold', removed && 'italic')}>
              {name}
            </span>
            <time
              className="shrink-0 text-[0.75rem] text-muted-foreground"
              dateTime={new Date(message.createdAt).toISOString()}
              title={full}
            >
              {time}
            </time>
          </div>
        )}
        {editing ? (
          <EditBox initial={message.text} onSave={onSave} onCancel={onCancel} />
        ) : (
          <p className="text-[0.9375rem] break-words whitespace-pre-wrap">
            <MessageText text={message.text} mentions={mentions} />
            {message.editedAt !== undefined && (
              <span className="text-[0.75rem] text-muted-foreground"> {t('chat.edited')}</span>
            )}
          </p>
        )}
        {message.failed && (
          <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-destructive">
            <WarningCircleIcon aria-hidden />
            <span>
              {t('chat.failed')} {translateError(message.failed, t)}
            </span>
            <Button size="sm" variant="ghost" onClick={onRetry}>
              <ArrowClockwiseIcon data-icon="inline-start" />
              {t('chat.retry')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDiscard}>
              <XIcon data-icon="inline-start" />
              {t('chat.discard')}
            </Button>
          </div>
        )}
      </div>
      {!editing && !message.pending && !message.failed && (onEdit || onDelete) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              aria-label={t('chat.actions', { name })}
            >
              <DotsThreeIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onEdit && (
              <DropdownMenuItem onSelect={onEdit}>
                <PencilSimpleIcon />
                {t('chat.edit')}
              </DropdownMenuItem>
            )}
            {onDelete && (
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <TrashIcon />
                {own ? t('chat.delete.action') : t('chat.delete.moderate')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

/** The text with its links and mentions; React escapes everything else. */
export function MessageText({
  text,
  mentions = [],
}: {
  text: string;
  mentions?: { userId: string; name: string }[];
}): ReactNode {
  return segments(text, mentions).map((segment, i) => {
    switch (segment.kind) {
      case 'link':
        return (
          <a
            key={i}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-primary underline underline-offset-2 break-all"
          >
            {segment.text}
          </a>
        );
      case 'mention':
        return (
          <span key={i} className="rounded bg-primary/10 px-0.5 font-medium text-primary">
            {segment.text}
          </span>
        );
      default:
        return <span key={i}>{segment.text}</span>;
    }
  });
}

function EditBox({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const tooLong = charCount(value.trim()) > CHAT_MAX_CHARS;
  return (
    <div className="flex flex-col gap-1">
      <Textarea
        autoFocus
        value={value}
        aria-label={t('chat.editLabel')}
        className="min-h-16"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (value.trim() !== '' && !tooLong) onSave(value);
          }
        }}
      />
      <p className="text-[0.75rem] text-muted-foreground">{t('chat.editHint')}</p>
    </div>
  );
}

function Composer({
  client,
  people,
  selfId,
}: {
  client: ChatClient;
  people: Person[];
  selfId: string | null;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /** Where the caret goes once a picked mention is in the value. */
  const nextCaret = useRef<number | null>(null);
  const listId = useId();
  const counterId = useId();
  const length = charCount(value.trim());
  const tooLong = length > CHAT_MAX_CHARS;

  const query = mentionQuery(value, caret);
  const suggestions =
    query && query.start !== dismissed
      ? people
          .filter((p) => p.userId !== selfId)
          .filter((p) => p.name.toLocaleLowerCase().startsWith(query.query.toLocaleLowerCase()))
          .slice(0, MAX_SUGGESTIONS)
      : [];
  const open = suggestions.length > 0;
  const active = Math.min(highlight, suggestions.length - 1);

  const pick = (person: Person) => {
    if (!query) return;
    const before = value.slice(0, query.start);
    const after = value.slice(caret);
    const inserted = `@${person.name} `;
    const next = before + inserted + after;
    setValue(next);
    const at = before.length + inserted.length;
    setCaret(at);
    nextCaret.current = at;
  };
  useLayoutEffect(() => {
    if (nextCaret.current === null) return;
    input.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = null;
  }, [value]);

  const submit = () => {
    if (value.trim() === '' || tooLong) return;
    client.send(value);
    setValue('');
    setCaret(0);
    setDismissed(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setHighlight((active + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const person = suggestions[active];
        if (person) {
          e.preventDefault();
          pick(person);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(query?.start ?? null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="relative flex items-end gap-2 border-t p-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('chat.mentionSuggestions')}
          className="absolute right-2 bottom-full left-2 z-10 mb-1 flex flex-col rounded-lg border bg-popover p-1 shadow-md"
        >
          {suggestions.map((person, i) => (
            <li
              key={person.userId}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[0.9375rem]',
                i === active && 'bg-accent text-accent-foreground',
              )}
              onMouseDown={(e) => {
                // Keep the focus in the textarea.
                e.preventDefault();
                pick(person);
              }}
            >
              <MemberAvatar name={person.name} avatarUrl={person.avatarUrl} size="sm" />
              <span className="truncate">{person.name}</span>
            </li>
          ))}
        </ul>
      )}
      <Textarea
        ref={input}
        value={value}
        rows={1}
        maxLength={CHAT_MAX_CHARS * 4}
        placeholder={t('chat.placeholder')}
        aria-label={t('chat.inputLabel')}
        aria-describedby={counterId}
        role="combobox"
        aria-autocomplete={AUTOCOMPLETE}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-invalid={tooLong || undefined}
        className="max-h-40 min-h-10 flex-1 resize-none"
        onChange={(e) => {
          setValue(e.target.value);
          setCaret(e.target.selectionStart);
          setHighlight(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      <Button
        type="submit"
        size="icon"
        disabled={value.trim() === '' || tooLong}
        aria-label={t('chat.send')}
      >
        <PaperPlaneRightIcon />
      </Button>
      <span
        id={counterId}
        className={cn(
          'absolute right-14 bottom-0.5 text-[0.6875rem] text-muted-foreground',
          length < CHAT_MAX_CHARS - 200 && 'sr-only',
          tooLong && 'text-destructive',
        )}
      >
        {t('chat.counter', { count: length, max: CHAT_MAX_CHARS })}
      </span>
    </form>
  );
}
