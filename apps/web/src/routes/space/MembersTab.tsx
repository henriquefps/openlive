// SPDX-License-Identifier: AGPL-3.0-only
import { DotsThreeIcon, UsersIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { errorBodyOf } from '../../api/client.ts';
import { assignableRoles, canActOn } from '@openlive/client';
import {
  type Member,
  membersQuery,
  type Space,
  useChangeRole,
  useRemoveMember,
  useSetBanned,
  useTransferSpace,
} from '../../api/spaces.ts';
import { EmptyState } from '../../components/EmptyState.tsx';
import { QueryError } from '../../components/QueryError.tsx';
import { translateError } from '../../i18n/errors.ts';
import { formatDate } from '../../i18n/format.ts';

const ROLE_ORDER = { owner: 0, admin: 1, member: 2, guest: 3 } as const;

export function MemberAvatar({
  name,
  avatarUrl,
  size,
}: {
  name: string;
  avatarUrl?: string | null | undefined;
  size?: 'default' | 'sm' | 'lg';
}) {
  return (
    <Avatar {...(size ? { size } : {})}>
      {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
      <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

export function MembersTab({ space, selfId }: { space: Space; selfId: string }) {
  const { t } = useTranslation();
  const members = useQuery(membersQuery(space.id));
  if (members.isPending) return <Skeleton className="h-28 w-full" />;
  if (members.isError) {
    return <QueryError error={members.error} onRetry={() => void members.refetch()} />;
  }
  const sorted = [...members.data].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.displayName.localeCompare(b.displayName),
  );
  const active = sorted.filter((m) => m.bannedAt === null);
  const banned = sorted.filter((m) => m.bannedAt !== null);
  if (active.length === 0) {
    return (
      <EmptyState
        icon={UsersIcon}
        title={t('space.members.empty.title')}
        description={t('space.members.empty.description')}
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <MemberList space={space} selfId={selfId} members={active} />
      {banned.length > 0 && (
        <section className="flex flex-col gap-3" aria-labelledby="banned-members">
          <h2 id="banned-members" className="eyebrow text-muted-foreground">
            {t('space.members.banned')}
          </h2>
          <MemberList space={space} selfId={selfId} members={banned} />
        </section>
      )}
    </div>
  );
}

function MemberList({
  space,
  selfId,
  members,
}: {
  space: Space;
  selfId: string;
  members: Member[];
}) {
  return (
    <ul className="flex flex-col divide-y rounded-xl border">
      {members.map((member) => (
        <MemberRow key={member.userId} space={space} selfId={selfId} member={member} />
      ))}
    </ul>
  );
}

type Confirm = 'ban' | 'remove' | 'transfer' | null;

function MemberRow({ space, selfId, member }: { space: Space; selfId: string; member: Member }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const changeRole = useChangeRole(space.id);
  const setBanned = useSetBanned(space.id);
  const remove = useRemoveMember(space.id);
  const transfer = useTransferSpace(space.id);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const confirmWith = {
    ban: () => setConfirm('ban'),
    remove: () => setConfirm('remove'),
    transfer: () => setConfirm('transfer'),
  };
  const actOn = canActOn(space.role, selfId, member);
  const roles = actOn ? assignableRoles(space.role) : [];
  const canTransfer = space.role === 'owner' && member.userId !== selfId && member.role !== 'guest';
  const showMenu = (actOn || canTransfer) && member.role !== 'owner';
  const onError = (error: unknown) => toast.error(translateError(errorBodyOf(error), t));
  const name = member.displayName;

  return (
    <li className="flex items-center gap-3 px-4 py-2 md:px-6">
      <MemberAvatar name={name} avatarUrl={member.avatarUrl} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-[0.9375rem]">
          <span className="truncate font-medium">{name}</span>
          {member.userId === selfId && (
            <span className="text-[0.8125rem] text-muted-foreground">{t('space.members.you')}</span>
          )}
        </span>
        <span className="truncate text-[0.8125rem] text-muted-foreground">
          {member.bannedAt !== null
            ? t('space.members.bannedAt', {
                date: formatDate(member.bannedAt, locale),
              })
            : t('space.members.joinedAt', { date: formatDate(member.joinedAt, locale) })}
        </span>
      </div>
      <Badge variant="outline">{t(`roles.${member.role}`)}</Badge>
      {showMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t('space.members.actions', { name })}>
              <DotsThreeIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {roles.length > 0 && member.bannedAt === null && (
              <>
                <DropdownMenuLabel>{t('space.members.role')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={member.role}
                  onValueChange={(role) =>
                    changeRole.mutate(
                      { userId: member.userId, role: role as 'admin' | 'member' | 'guest' },
                      { onError },
                    )
                  }
                >
                  {roles.map((role) => (
                    <DropdownMenuRadioItem key={role} value={role}>
                      {t(`roles.${role}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuGroup>
              {canTransfer && member.bannedAt === null && (
                <DropdownMenuItem onSelect={confirmWith.transfer}>
                  {t('space.members.transfer')}
                </DropdownMenuItem>
              )}
              {actOn &&
                (member.bannedAt === null ? (
                  <>
                    <DropdownMenuItem onSelect={confirmWith.remove}>
                      {t('space.members.remove')}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={confirmWith.ban}>
                      {t('space.members.ban')}
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem
                    onSelect={() =>
                      setBanned.mutate({ userId: member.userId, banned: false }, { onError })
                    }
                  >
                    {t('space.members.unban')}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm && t(`space.members.confirm.${confirm}.title`, { name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm && t(`space.members.confirm.${confirm}.description`, { name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm === 'transfer' ? 'default' : 'destructive'}
              onClick={() => {
                if (confirm === 'ban') {
                  setBanned.mutate({ userId: member.userId, banned: true }, { onError });
                } else if (confirm === 'remove') {
                  remove.mutate(member.userId, { onError });
                } else if (confirm === 'transfer') {
                  transfer.mutate(member.userId, { onError });
                }
              }}
            >
              {confirm && t(`space.members.confirm.${confirm}.action`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
