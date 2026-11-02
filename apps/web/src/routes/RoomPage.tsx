// SPDX-License-Identifier: AGPL-3.0-only
import { DoorOpenIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { roomsQuery, type Space } from '../api/spaces.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { roomTrail } from '../components/breadcrumbs.ts';
import { Page } from '../components/Page.tsx';
import { QueryError } from '../components/QueryError.tsx';
import { RoomView } from './room/RoomView.tsx';
import { useSpaceBySlug } from './space/use-space.ts';

const slugRoute = getRouteApi('/s/$spaceSlug/r/$roomSlug');
const idRoute = getRouteApi('/rooms/$roomId');

/** /s/:space/r/:room: finds the room among the space's rooms, then shows it. */
export function RoomPage() {
  const { t } = useTranslation();
  const { spaceSlug, roomSlug } = slugRoute.useParams();
  const { space, isPending, notFound } = useSpaceBySlug(spaceSlug);
  const rooms = useQuery({ ...roomsQuery(space.data?.id ?? ''), enabled: !!space.data });
  const room = rooms.data?.find((r) => r.slug === roomSlug);
  // Once found, the page keeps showing this room: after a kick or a close the refreshed lists
  // no longer contain it, and the room's own "you were removed" or "closed" state must stay.
  const [kept, setKept] = useState<{ key: string; roomId: string; space: Space } | null>(null);
  const key = `${spaceSlug}/${roomSlug}`;
  if (room && space.data && kept?.roomId !== room.id) {
    setKept({ key, roomId: room.id, space: space.data });
  }
  if (kept?.key === key) {
    return <RoomView key={kept.roomId} roomId={kept.roomId} space={kept.space} />;
  }
  const trail = roomTrail(
    t,
    { slug: spaceSlug, name: space.data?.name },
    {
      name: room?.name,
      link: { to: '/s/$spaceSlug/r/$roomSlug', params: { spaceSlug, roomSlug } },
    },
  );
  const notFoundTrail = roomTrail(
    t,
    { slug: spaceSlug, name: space.data?.name },
    { name: t('room.notFound') },
  );
  if (isPending || (space.data && rooms.isPending)) {
    return (
      <Page title={t('room.loading')} breadcrumbs={trail}>
        <Skeleton className="h-40 w-full" />
      </Page>
    );
  }
  if (space.isError || rooms.isError) {
    return (
      <Page title={t('room.loading')} breadcrumbs={trail}>
        <QueryError error={space.error ?? rooms.error} onRetry={() => void rooms.refetch()} />
      </Page>
    );
  }
  if (notFound || !space.data || !room) {
    return (
      <Page title={t('room.notFound')} breadcrumbs={notFoundTrail}>
        <EmptyState
          icon={DoorOpenIcon}
          title={t('room.notFound')}
          description={t('errors.room_not_found')}
        >
          <Button variant="outline" asChild>
            {space.data ? (
              <Link to="/s/$spaceSlug" params={{ spaceSlug }}>
                {t('room.backToSpace', { space: space.data.name })}
              </Link>
            ) : (
              <Link to="/spaces">{t('invite.toSpaces')}</Link>
            )}
          </Button>
        </EmptyState>
      </Page>
    );
  }
  return <RoomView key={room.id} roomId={room.id} space={space.data} />;
}

/** /rooms/:id: the same room page by id, for guests of one room who cannot see its space. */
export function RoomByIdPage() {
  const { roomId } = idRoute.useParams();
  return <RoomView roomId={roomId} space={null} />;
}
