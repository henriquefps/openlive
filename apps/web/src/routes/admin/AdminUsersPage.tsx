// SPDX-License-Identifier: AGPL-3.0-only
import {
  DevicesIcon,
  MagnifyingGlassIcon,
  ProhibitIcon,
  SignOutIcon,
  TrashIcon,
  UserCheckIcon,
} from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import {
  type AdminUser,
  type AdminUserDetail,
  banUser,
  DELETED_MESSAGES,
  type DeletedMessages,
  deleteUser,
  revokeUserDevices,
  revokeUserSessions,
  unbanUser,
  USER_FILTERS,
  type UserFilter,
  userQuery,
  usersQuery,
} from '../../api/admin.ts';
import { meQuery } from '../../api/auth.ts';
import { errorBodyOf } from '../../api/client.ts';
import { DataCard, DataList, RelativeDate } from '../../components/data-list.tsx';
import { platformTrail } from '../../components/breadcrumbs.ts';
import { Page } from '../../components/Page.tsx';
import { StatusBadge } from '../../components/StatusBadge.tsx';
import { translateError } from '../../i18n/errors.ts';
import { formatDate } from '../../i18n/format.ts';
import { describeUserAgent } from '../../lib/user-agent.ts';
import { useTutorialScreen } from '../../tutorial/context.ts';

// /admin/users: every account on the instance, the spaces it belongs to, and the
// platform-wide actions (ban, sign-out, unpairing, deletion). Metadata only: the platform admin
// never sees stream content, and the API never returns IP addresses.

const SEARCH_DELAY_MS = 300;

const useLocale = () => {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage ?? i18n.language;
};

const dateTime = (value: number, locale: string) =>
  formatDate(value, locale, { dateStyle: 'medium', timeStyle: 'short' });

export function AdminUsersPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/admin/users' });
  const navigate = useNavigate({ from: '/admin/users' });
  const filter: UserFilter = search.filter ?? 'all';
  const query = search.q ?? '';
  const [text, setText] = useState(query);
  const users = useInfiniteQuery(usersQuery(filter, query));
  useTutorialScreen('admin-users', users.isSuccess);

  // The search follows the typing after a short pause, and lives in the URL.
  useEffect(() => {
    const next = text.trim();
    if (next === query) return;
    const timer = setTimeout(() => {
      void navigate({ search: (s) => ({ ...s, q: next || undefined }), replace: true });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, query, navigate]);

  const setFilter = (value: string) => {
    const f = USER_FILTERS.find((x) => x === value) ?? 'all';
    void navigate({
      search: (s) => ({ ...s, filter: f === 'all' ? undefined : f }),
      replace: true,
    });
  };
  const open = (userId: string | undefined) =>
    void navigate({ search: (s) => ({ ...s, user: userId }) });

  const rows = users.data?.pages.flatMap((p) => p.users) ?? [];
  // The open account is the last crumb: Platform › Users › <user>, back to the list. The sheet
  // loads the same detail query, so its name costs no request.
  const detail = useQuery({ ...userQuery(search.user ?? ''), enabled: search.user !== undefined });
  const trail = platformTrail(
    t,
    'users',
    search.user === undefined
      ? undefined
      : {
          name: detail.data?.displayName ?? rows.find((u) => u.id === search.user)?.displayName,
        },
  );
  return (
    <Page title={t('admin.users.title')} description={t('admin.users.intro')} breadcrumbs={trail}>
      <div className="@container flex flex-col gap-3">
        <div className="flex flex-col gap-2 @md:flex-row @md:items-center">
          <InputGroup className="min-w-0 flex-1" data-tour="admin-users-search">
            <InputGroupAddon>
              <MagnifyingGlassIcon />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('admin.users.searchPlaceholder')}
              aria-label={t('admin.users.search')}
            />
          </InputGroup>
          <div data-tour="admin-users-filter">
            <ToggleGroup
              type="single"
              variant="outline"
              value={filter}
              onValueChange={(value) => value && setFilter(value)}
              aria-label={t('admin.users.filter')}
              className="hidden @2xl:flex"
            >
              {USER_FILTERS.map((f) => (
                <ToggleGroupItem key={f} value={f}>
                  {t(`admin.users.filters.${f}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger
                className="w-full @md:w-44 @2xl:hidden"
                aria-label={t('admin.users.filter')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {USER_FILTERS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {t(`admin.users.filters.${f}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {users.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{translateError(errorBodyOf(users.error), t)}</AlertDescription>
          </Alert>
        ) : users.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">
            {query ? t('admin.users.noMatch') : t(`admin.users.empty.${filter}`)}
          </p>
        ) : (
          <DataList
            items={rows}
            getKey={(user) => user.id}
            data-tour="admin-users-list"
            renderTable={(items) => (
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-auto min-w-48 pl-4 md:pl-6">
                      {t('admin.users.columns.name')}
                    </TableHead>
                    <TableHead className="hidden w-[40%] @3xl:table-cell">
                      {t('admin.users.columns.spaces')}
                    </TableHead>
                    <TableHead className="hidden w-36 @5xl:table-cell">
                      {t('admin.users.columns.lastSeen')}
                    </TableHead>
                    <TableHead className="w-36 pr-4 md:pr-6">
                      {t('admin.users.columns.status')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((user) => (
                    <UserRow
                      key={user.id}
                      user={user}
                      selected={search.user === user.id}
                      onOpen={() => open(user.id)}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
            renderCard={(user) => (
              <UserCard
                user={user}
                selected={search.user === user.id}
                onOpen={() => open(user.id)}
              />
            )}
          />
        )}
        {users.hasNextPage && (
          <div>
            <Button
              variant="outline"
              disabled={users.isFetchingNextPage}
              onClick={() => void users.fetchNextPage()}
            >
              {t('admin.users.more')}
            </Button>
          </div>
        )}
      </div>
      <UserSheet userId={search.user} onClose={() => open(undefined)} />
    </Page>
  );
}

function initials(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || '?';
}

function SpaceBadges({ user }: { user: AdminUser }) {
  const { t } = useTranslation();
  if (user.spaces.length === 0) {
    return (
      <span className="text-[0.8125rem] text-muted-foreground">{t('admin.users.noSpace')}</span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {user.spaces.map((s) => (
        <Badge
          key={s.id}
          variant="outline"
          className={cn('max-w-full', s.bannedAt !== null && 'text-destructive')}
        >
          <span className="truncate">{s.name}</span>
          <span className="text-muted-foreground">
            {s.bannedAt !== null ? t('admin.users.spaceBanned') : t(`roles.${s.role}`)}
          </span>
        </Badge>
      ))}
    </div>
  );
}

function UserStatus({ user }: { user: AdminUser }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1">
      {user.bannedAt !== null ? (
        <StatusBadge tone="failed">{t('admin.users.status.banned')}</StatusBadge>
      ) : (
        <StatusBadge tone="ok">{t('admin.users.status.active')}</StatusBadge>
      )}
      {user.isPlatformAdmin && <Badge variant="outline">{t('admin.users.status.admin')}</Badge>}
    </div>
  );
}

function UserCard({
  user,
  selected,
  onOpen,
}: {
  user: AdminUser;
  selected: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <DataCard
      selected={selected}
      onOpen={onOpen}
      title={user.displayName}
      badge={<UserStatus user={user} />}
      meta={[
        <span key="id" className="font-mono [overflow-wrap:anywhere]">
          {user.primaryEmail ?? user.id}
        </span>,
        t('admin.users.spaceCount', { count: user.spaces.length }),
        user.lastSeenAt === null ? (
          t('admin.users.never')
        ) : (
          <RelativeDate key="seen" value={user.lastSeenAt} locale={locale} />
        ),
      ]}
    />
  );
}

function UserRow({
  user,
  selected,
  onOpen,
}: {
  user: AdminUser;
  selected: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <TableRow
      data-state={selected ? 'selected' : undefined}
      className={cn(
        'cursor-pointer hover:bg-muted/50',
        selected && 'bg-muted shadow-[inset_2px_0_0_var(--primary)]',
      )}
      onClick={onOpen}
    >
      <TableCell className="py-2 pl-4 md:pl-6">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-8 shrink-0">
            {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
            <AvatarFallback>{initials(user.displayName)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col">
            <button
              type="button"
              className="truncate text-left text-[0.9375rem] focus-visible:underline focus-visible:outline-none"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
            >
              {user.displayName}
            </button>
            <span className="truncate font-mono text-[0.8125rem] text-muted-foreground">
              {user.primaryEmail ?? user.id}
            </span>
            {/* Narrow lists fold the spaces into a third line. */}
            <div className="mt-1 @3xl:hidden">
              <SpaceBadges user={user} />
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden py-2 @3xl:table-cell">
        <SpaceBadges user={user} />
      </TableCell>
      <TableCell className="hidden font-mono text-[0.8125rem] text-muted-foreground tabular-nums @5xl:table-cell">
        {user.lastSeenAt === null ? t('admin.users.never') : formatDate(user.lastSeenAt, locale)}
      </TableCell>
      <TableCell className="py-2 pr-4 md:pr-6">
        <UserStatus user={user} />
      </TableCell>
    </TableRow>
  );
}

// --- detail ---------------------------------------------------------------------------------

type Pending = 'ban' | 'unban' | 'sessions' | 'devices' | 'delete' | null;

function UserSheet({ userId, onClose }: { userId: string | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const detail = useQuery({ ...userQuery(userId ?? ''), enabled: userId !== undefined });
  return (
    <Sheet open={userId !== undefined} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        className="overflow-y-auto data-[side=right]:w-full data-[side=right]:border-l-0 data-[side=right]:sm:max-w-xl data-[side=right]:sm:border-l"
        closeLabel={t('common.close')}
      >
        {detail.data ? (
          <UserDetail user={detail.data} onDeleted={onClose} />
        ) : (
          <SheetHeader>
            <SheetTitle>{t('admin.users.detail.loading')}</SheetTitle>
            <SheetDescription className="sr-only">{t('admin.users.intro')}</SheetDescription>
            {detail.isError ? (
              <Alert variant="destructive">
                <AlertDescription>{translateError(errorBodyOf(detail.error), t)}</AlertDescription>
              </Alert>
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t px-4 pt-4">
      <h3 className="eyebrow text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function UserDetail({ user, onDeleted }: { user: AdminUserDetail; onDeleted: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useQuery(meQuery);
  const self = me.data?.user.id === user.id;
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const banned = user.bannedAt !== null;
  const owned = user.spaces.filter((s) => s.role === 'owner');
  const ask = (action: Exclude<Pending, null>) => () => setPending(action);
  const confirmFor = {
    ban: ask('ban'),
    unban: ask('unban'),
    sessions: ask('sessions'),
    devices: ask('devices'),
    delete: ask('delete'),
  };

  return (
    <div className="flex flex-col gap-4 pb-6">
      <SheetHeader className="gap-3">
        <div className="flex min-w-0 items-center gap-3 pr-8">
          <Avatar className="size-10 shrink-0">
            {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
            <AvatarFallback>{initials(user.displayName)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col">
            <SheetTitle className="truncate text-lg font-semibold">{user.displayName}</SheetTitle>
            <SheetDescription className="truncate font-mono text-[0.8125rem]">
              {user.primaryEmail ?? user.id}
            </SheetDescription>
          </div>
        </div>
        <UserStatus user={user} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.8125rem]">
          <dt className="text-muted-foreground">{t('admin.users.detail.id')}</dt>
          <dd className="truncate font-mono">{user.id}</dd>
          <dt className="text-muted-foreground">{t('admin.users.detail.providers')}</dt>
          <dd>
            {user.providers.length > 0
              ? user.providers.map((p) => t(`admin.users.providers.${p}`)).join(', ')
              : '—'}
          </dd>
          <dt className="text-muted-foreground">{t('admin.users.detail.created')}</dt>
          <dd className="tabular-nums">{dateTime(user.createdAt, locale)}</dd>
          <dt className="text-muted-foreground">{t('admin.users.columns.lastSeen')}</dt>
          <dd className="tabular-nums">
            {user.lastSeenAt === null ? t('admin.users.never') : dateTime(user.lastSeenAt, locale)}
          </dd>
        </dl>
        {banned && (
          <Alert variant="destructive">
            <ProhibitIcon />
            <AlertTitle>
              {t('admin.users.detail.bannedAt', { date: dateTime(user.bannedAt ?? 0, locale) })}
            </AlertTitle>
            {user.bannedReason && <AlertDescription>{user.bannedReason}</AlertDescription>}
          </Alert>
        )}
        {notice && (
          <p role="status" className="text-[0.8125rem] text-muted-foreground">
            {notice}
          </p>
        )}
        <div className="flex flex-wrap gap-2" data-tour="admin-users-actions">
          {banned ? (
            <Button variant="outline" onClick={confirmFor.unban}>
              <UserCheckIcon data-icon="inline-start" />
              {t('admin.users.actions.unban')}
            </Button>
          ) : (
            <Button variant="destructive" disabled={self} onClick={confirmFor.ban}>
              <ProhibitIcon data-icon="inline-start" />
              {t('admin.users.actions.ban')}
            </Button>
          )}
          <Button
            variant="outline"
            disabled={user.sessions.length === 0}
            onClick={confirmFor.sessions}
          >
            <SignOutIcon data-icon="inline-start" />
            {t('admin.users.actions.sessions')}
          </Button>
          <Button
            variant="outline"
            disabled={user.devices.length === 0}
            onClick={confirmFor.devices}
          >
            <DevicesIcon data-icon="inline-start" />
            {t('admin.users.actions.devices')}
          </Button>
          <Button variant="outline" disabled={self} onClick={confirmFor.delete}>
            <TrashIcon data-icon="inline-start" />
            {t('admin.users.actions.delete')}
          </Button>
        </div>
        {self && (
          <p className="text-[0.8125rem] text-muted-foreground">{t('admin.users.detail.self')}</p>
        )}
      </SheetHeader>

      <Section title={t('admin.users.detail.spaces')}>
        {user.spaces.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">{t('admin.users.noSpace')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {user.spaces.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[0.9375rem]">{s.name}</span>
                  <span className="truncate font-mono text-[0.8125rem] text-muted-foreground">
                    {s.slug}
                  </span>
                </span>
                {s.bannedAt !== null ? (
                  <StatusBadge tone="failed">{t('admin.users.spaceBanned')}</StatusBadge>
                ) : (
                  <Badge variant="outline">{t(`roles.${s.role}`)}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('admin.users.detail.streams')}>
        {user.streams.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">
            {t('admin.users.detail.noStreams')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {user.streams.map((s) => (
              <li key={s.streamId} className="flex flex-col">
                <span className="text-[0.9375rem]">
                  {t('admin.users.detail.streamIn', { room: s.roomName, space: s.spaceName })}
                </span>
                <span className="text-[0.8125rem] text-muted-foreground">
                  {t('admin.users.detail.streamMeta', {
                    preset: t(`presets.${s.preset}`),
                    since: dateTime(s.startedAt, locale),
                    count: s.viewerCount,
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('admin.users.detail.sessions')}>
        {user.sessions.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">
            {t('admin.users.detail.noSessions')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {user.sessions.map((s) => {
              const { browser, os } = describeUserAgent(s.userAgent);
              const name =
                browser && os
                  ? t('settings.sessions.device', { browser, os })
                  : (browser ?? os ?? t('settings.sessions.unknownDevice'));
              return (
                <li key={s.id} className="flex flex-col">
                  <span className="text-[0.9375rem]">{name}</span>
                  <span className="text-[0.8125rem] text-muted-foreground">
                    {t('admin.users.detail.sessionMeta', {
                      created: dateTime(s.createdAt, locale),
                      seen: dateTime(s.lastSeenAt, locale),
                    })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title={t('admin.users.detail.devices')}>
        {user.devices.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">
            {t('admin.users.detail.noDevices')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {user.devices.map((d) => (
              <li key={d.deviceId} className="flex flex-col">
                <span className="text-[0.9375rem]">{d.name}</span>
                <span className="font-mono text-[0.8125rem] text-muted-foreground">
                  {`${d.os}/${d.arch} · ${d.helperVersion}`}
                  {d.lastSeenAt !== undefined &&
                    ` · ${t('admin.users.detail.seen', { date: dateTime(d.lastSeenAt, locale) })}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('admin.users.detail.activity')}>
        {user.audit.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">
            {t('admin.users.detail.noActivity')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {user.audit.map((a) => (
              <li key={a.id} className="flex flex-col">
                <span className="text-[0.9375rem]">
                  {t(`admin.users.audit.${a.action.replaceAll('.', '_')}`, {
                    defaultValue: a.action,
                  })}
                </span>
                <span className="text-[0.8125rem] text-muted-foreground">
                  {[
                    dateTime(a.createdAt, locale),
                    a.spaceName,
                    a.actorId === user.id
                      ? t('admin.users.detail.byThem')
                      : a.actorName
                        ? t('admin.users.detail.by', { name: a.actorName })
                        : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <BanDialog user={user} open={pending === 'ban'} onDone={() => setPending(null)} />
      <ConfirmDialog
        open={pending === 'unban'}
        title={t('admin.users.confirm.unbanTitle', { name: user.displayName })}
        description={t('admin.users.confirm.unbanBody')}
        action={t('admin.users.actions.unban')}
        run={() => unbanUser(user.id)}
        onDone={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === 'sessions'}
        title={t('admin.users.confirm.sessionsTitle', { name: user.displayName })}
        description={t('admin.users.confirm.sessionsBody')}
        action={t('admin.users.actions.sessions')}
        destructive
        run={async () => {
          const n = await revokeUserSessions(user.id);
          setNotice(t('admin.users.done.sessions', { count: n }));
        }}
        onDone={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === 'devices'}
        title={t('admin.users.confirm.devicesTitle', { name: user.displayName })}
        description={t('admin.users.confirm.devicesBody')}
        action={t('admin.users.actions.devices')}
        destructive
        run={async () => {
          const n = await revokeUserDevices(user.id);
          setNotice(t('admin.users.done.devices', { count: n }));
        }}
        onDone={() => setPending(null)}
      />
      <DeleteDialog
        user={user}
        owned={owned}
        open={pending === 'delete'}
        onDone={(deleted) => {
          setPending(null);
          if (deleted) onDeleted();
        }}
      />
    </div>
  );
}

function ConfirmDialog({
  open,
  title,
  description,
  action,
  destructive = false,
  run,
  onDone,
}: {
  open: boolean;
  title: string;
  description: string;
  action: string;
  destructive?: boolean;
  run: () => Promise<unknown>;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const mutation = useMutation({ mutationFn: run, onSuccess: onDone });
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          mutation.reset();
          onDone();
        }
      }}
    >
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {mutation.isError && (
          <Alert variant="destructive">
            <AlertDescription>{translateError(errorBodyOf(mutation.error), t)}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={mutation.isPending}
            onClick={(e) => {
              // Stays open until the call is done, so an error can be shown.
              e.preventDefault();
              mutation.mutate();
            }}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function BanDialog({
  user,
  open,
  onDone,
}: {
  user: AdminUserDetail;
  open: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const ban = useMutation({
    mutationFn: () => banUser(user.id, reason),
    onSuccess: () => {
      setReason('');
      onDone();
    },
  });
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          ban.reset();
          onDone();
        }
      }}
    >
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('admin.users.confirm.banTitle', { name: user.displayName })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('admin.users.confirm.banBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor={reasonId}>{t('admin.users.confirm.reason')}</FieldLabel>
          <Textarea
            id={reasonId}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
          <FieldDescription>{t('admin.users.confirm.reasonHint')}</FieldDescription>
        </Field>
        {ban.isError && (
          <Alert variant="destructive">
            <AlertDescription>{translateError(errorBodyOf(ban.error), t)}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={ban.isPending}
            onClick={(e) => {
              e.preventDefault();
              ban.mutate();
            }}
          >
            {t('admin.users.actions.ban')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteDialog({
  user,
  owned,
  open,
  onDone,
}: {
  user: AdminUserDetail;
  owned: AdminUserDetail['spaces'];
  open: boolean;
  onDone: (deleted: boolean) => void;
}) {
  const { t } = useTranslation();
  const banId = useId();
  const messagesId = useId();
  const [alsoBan, setAlsoBan] = useState(user.bannedAt !== null);
  const [messages, setMessages] = useState<DeletedMessages>('delete');
  const remove = useMutation({
    mutationFn: () => deleteUser(user.id, alsoBan, messages),
    onSuccess: () => onDone(true),
  });
  const blocked = owned.length > 0;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          remove.reset();
          onDone(false);
        }
      }}
    >
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('admin.users.confirm.deleteTitle', { name: user.displayName })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('admin.users.confirm.deleteBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        {blocked ? (
          <Alert variant="destructive">
            <AlertTitle>{t('admin.users.confirm.ownerTitle')}</AlertTitle>
            <AlertDescription>
              <p>{t('admin.users.confirm.ownerBody')}</p>
              <ul className="list-disc pl-5">
                {owned.map((s) => (
                  <li key={s.id}>
                    <Link to="/s/$spaceSlug" params={{ spaceSlug: s.slug }} className="underline">
                      {s.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor={banId}>{t('admin.users.confirm.alsoBan')}</FieldLabel>
                <FieldDescription>{t('admin.users.confirm.alsoBanHint')}</FieldDescription>
              </FieldContent>
              <Switch
                id={banId}
                checked={alsoBan}
                disabled={user.bannedAt !== null}
                onCheckedChange={setAlsoBan}
              />
            </Field>
            {/* The admin chooses; the admin never reads them. */}
            <Field>
              <FieldLabel htmlFor={messagesId}>{t('admin.users.confirm.messages')}</FieldLabel>
              <Select
                value={messages}
                onValueChange={(v) => {
                  const chosen = DELETED_MESSAGES.find((m) => m === v);
                  if (chosen) setMessages(chosen);
                }}
              >
                <SelectTrigger id={messagesId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DELETED_MESSAGES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {t(`admin.users.confirm.messagesChoice.${m}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{t('admin.users.confirm.messagesHint')}</FieldDescription>
            </Field>
          </>
        )}
        {remove.isError && (
          <Alert variant="destructive">
            <AlertDescription>{translateError(errorBodyOf(remove.error), t)}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={blocked || remove.isPending}
            onClick={(e) => {
              e.preventDefault();
              remove.mutate();
            }}
          >
            {t('admin.users.actions.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
