// SPDX-License-Identifier: AGPL-3.0-only
import { KeyIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from '@/components/ui/responsive-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { isManager } from '../../api/permissions.ts';
import {
  type Member,
  membersQuery,
  type Room,
  type RoomAccess,
  roomAccessQuery,
  useGrantRoomAccess,
  useRevokeRoomAccess,
} from '../../api/spaces.ts';
import { ErrorText, QueryError } from '../../components/QueryError.tsx';
import { MemberAvatar } from '../space/MembersTab.tsx';

/**
 * Who sees a restricted room (room_access). Owners and admins always see it;
 * members and guests need a grant, and a guest's grant can carry the stream permission.
 */
export function RoomAccessDialog({ room }: { room: Room }) {
  const { t } = useTranslation();
  return (
    <ResponsiveDialog>
      <ResponsiveDialogTrigger asChild>
        <Button variant="outline">
          <KeyIcon data-icon="inline-start" />
          {t('room.access.action')}
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t('room.access.title', { name: room.name })}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{t('room.access.description')}</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <AccessList room={room} />
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function AccessList({ room }: { room: Room }) {
  const { t } = useTranslation();
  const access = useQuery(roomAccessQuery(room.id));
  const members = useQuery(membersQuery(room.spaceId));
  const grant = useGrantRoomAccess(room.id);
  const revoke = useRevokeRoomAccess(room.id);
  if (access.isPending || members.isPending) return <Skeleton className="h-28 w-full" />;
  if (access.isError || members.isError) {
    return <QueryError error={access.error ?? members.error} />;
  }
  const byId = new Map(members.data.map((m) => [m.userId, m]));
  const granted = access.data.filter((a) => a.canView);
  const grantedIds = new Set(granted.map((a) => a.userId));
  const candidates = members.data.filter(
    (m) => m.bannedAt === null && !isManager(m.role) && !grantedIds.has(m.userId),
  );

  return (
    <div className="flex max-h-[60svh] flex-col gap-4 overflow-y-auto max-md:max-h-none max-md:overflow-visible">
      <ErrorText error={grant.error ?? revoke.error} />
      <section className="flex flex-col gap-2" aria-labelledby="room-access-granted">
        <h3 id="room-access-granted" className="eyebrow text-muted-foreground">
          {t('room.access.granted')}
        </h3>
        {granted.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">{t('room.access.none')}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-xl border">
            {granted.map((entry) => (
              <GrantRow
                key={entry.userId}
                entry={entry}
                member={byId.get(entry.userId)}
                busy={grant.isPending || revoke.isPending}
                onStream={(canStream) =>
                  grant.mutate({ userId: entry.userId, canView: true, canStream })
                }
                onRevoke={() => revoke.mutate(entry.userId)}
              />
            ))}
          </ul>
        )}
      </section>
      {candidates.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="room-access-add">
          <h3 id="room-access-add" className="eyebrow text-muted-foreground">
            {t('room.access.add')}
          </h3>
          <ul className="flex flex-col divide-y rounded-xl border">
            {candidates.map((member) => (
              <li key={member.userId} className="flex items-center gap-3 px-3 py-2">
                <MemberAvatar name={member.displayName} avatarUrl={member.avatarUrl} />
                <span className="min-w-0 flex-1 truncate text-[0.9375rem]">
                  {member.displayName}
                </span>
                <Button
                  variant="outline"
                  disabled={grant.isPending}
                  onClick={() => grant.mutate({ userId: member.userId, canView: true })}
                  aria-label={t('room.access.grantLabel', { name: member.displayName })}
                >
                  <PlusIcon data-icon="inline-start" />
                  {t('room.access.grant')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function GrantRow({
  entry,
  member,
  busy,
  onStream,
  onRevoke,
}: {
  entry: RoomAccess;
  member: Member | undefined;
  busy: boolean;
  onStream: (canStream: boolean) => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  const name = member?.displayName ?? t('room.access.roomGuest');
  // Members stream anyway; the per-room stream permission is for guests (6.4.5).
  const guest = !member || member.role === 'guest';
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2">
      <MemberAvatar name={name} avatarUrl={member?.avatarUrl} />
      <span className="min-w-0 flex-1 truncate text-[0.9375rem]">{name}</span>
      {guest && (
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={entry.canStream} disabled={busy} onCheckedChange={onStream} />
          {t('room.access.canStream')}
        </label>
      )}
      <Button
        variant="outline"
        disabled={busy}
        onClick={onRevoke}
        aria-label={t('room.access.revokeLabel', { name })}
      >
        {t('room.access.revoke')}
      </Button>
    </li>
  );
}
