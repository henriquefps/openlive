// SPDX-License-Identifier: AGPL-3.0-only
import { HandWavingIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type JoinRequest,
  joinRequestsQuery,
  roomsQuery,
  type Space,
  useDecideJoinRequest,
} from '../../api/spaces.ts';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorText, QueryError } from '../../components/QueryError.tsx';
import { formatDate } from '../../i18n/format.ts';
import { MemberAvatar } from './MembersTab.tsx';

/** Pending join requests from invites that need approval (owners and admins). */
export function RequestsTab({ space }: { space: Space }) {
  const { t } = useTranslation();
  const requests = useQuery(joinRequestsQuery(space.id));
  const rooms = useQuery(roomsQuery(space.id));
  if (requests.isPending) return <Skeleton className="h-28 w-full" />;
  if (requests.isError) {
    return <QueryError error={requests.error} onRetry={() => void requests.refetch()} />;
  }
  if (requests.data.length === 0) {
    return (
      <EmptyState
        icon={HandWavingIcon}
        title={t('space.requests.empty.title')}
        description={t('space.requests.empty.description')}
      />
    );
  }
  return (
    <ul className="flex flex-col divide-y rounded-xl border">
      {requests.data.map((request) => (
        <RequestRow
          key={request.id}
          space={space}
          request={request}
          roomName={
            request.roomId === null
              ? null
              : (rooms.data?.find((r) => r.id === request.roomId)?.name ?? request.roomId)
          }
        />
      ))}
    </ul>
  );
}

function RequestRow({
  space,
  request,
  roomName,
}: {
  space: Space;
  request: JoinRequest;
  roomName: string | null;
}) {
  const { t, i18n } = useTranslation();
  const decide = useDecideJoinRequest(space.id);
  const name = request.displayName ?? t('space.requests.unknown');
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const approve = () => decide.mutate({ joinRequestId: request.id, decision: 'approve' });
  const reject = () => decide.mutate({ joinRequestId: request.id, decision: 'reject' });
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2 md:px-6">
      <MemberAvatar name={name} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[0.9375rem] font-medium">{name}</span>
        <span className="truncate text-[0.8125rem] text-muted-foreground">
          {t(roomName ? 'space.requests.toRoom' : 'space.requests.toSpace', {
            room: roomName,
            date: formatDate(request.createdAt, locale, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </span>
        <ErrorText error={decide.error} />
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={decide.isPending}
          onClick={reject}
          aria-label={t('space.requests.rejectLabel', { name })}
        >
          {t('space.requests.reject')}
        </Button>
        <Button
          disabled={decide.isPending}
          onClick={approve}
          aria-label={t('space.requests.approveLabel', { name })}
        >
          {t('space.requests.approve')}
        </Button>
      </div>
    </li>
  );
}
