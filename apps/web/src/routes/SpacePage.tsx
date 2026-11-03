// SPDX-License-Identifier: AGPL-3.0-only
import { DoorOpenIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { spaceAbilities } from '@openlive/client';
import { joinRequestsQuery } from '../api/spaces.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { spaceTrail } from '../components/breadcrumbs.ts';
import { Page } from '../components/Page.tsx';
import { QueryError } from '../components/QueryError.tsx';
import { InvitesTab } from './space/InvitesTab.tsx';
import { MembersTab } from './space/MembersTab.tsx';
import { RequestsTab } from './space/RequestsTab.tsx';
import { CreateFixedRoomDialog, QuickRoomButton, RoomsTab } from './space/RoomsTab.tsx';
import { SettingsTab } from './space/SettingsTab.tsx';
import { StatusTab } from './space/StatusTab.tsx';
import { SPACE_TABS, type SpaceTab } from './space/tabs.ts';
import { useTutorialScreen } from '../tutorial/context.ts';
import { useSpaceBySlug } from './space/use-space.ts';

const route = getRouteApi('/s/$spaceSlug/');

/** /s/:slug: fixed rooms, active quick rooms, members, invites, join requests and settings. */
export function SpacePage() {
  const { t } = useTranslation();
  const { spaceSlug } = route.useParams();
  const { tab = 'rooms' } = route.useSearch();
  const navigate = route.useNavigate();
  const { me, space, isPending, notFound } = useSpaceBySlug(spaceSlug);
  useTutorialScreen('space', space.isSuccess && !notFound);
  const loadingTrail = spaceTrail(t, {
    slug: spaceSlug,
    name: me?.memberships.find((m) => m.slug === spaceSlug)?.name,
  });

  if (isPending) {
    return (
      <Page title={t('space.loading')} breadcrumbs={loadingTrail}>
        <Skeleton className="h-9 w-80 max-w-full" />
        <Skeleton className="h-40 w-full" />
      </Page>
    );
  }
  if (notFound || !me) {
    return (
      <Page
        title={t('space.notFound.title')}
        breadcrumbs={spaceTrail(t, { slug: spaceSlug, name: t('space.notFound.title') })}
      >
        <EmptyState
          icon={DoorOpenIcon}
          title={t('space.notFound.title')}
          description={t('errors.space_not_found')}
        >
          <Button variant="outline" asChild>
            <Link to="/spaces">{t('invite.toSpaces')}</Link>
          </Button>
        </EmptyState>
      </Page>
    );
  }
  if (space.isError) {
    return (
      <Page title={t('space.loading')} breadcrumbs={loadingTrail}>
        <QueryError error={space.error} onRetry={() => void space.refetch()} />
      </Page>
    );
  }
  const data = space.data;
  if (!data) return null;
  const abilities = spaceAbilities(data);
  const tabs = SPACE_TABS.filter(
    (name) =>
      (name !== 'invites' || abilities.viewInvites) &&
      (name !== 'requests' || abilities.decideJoinRequests) &&
      (name !== 'status' || abilities.viewStatus),
  );
  const current = tabs.includes(tab) ? tab : 'rooms';

  return (
    <Page
      title={data.name}
      description={t('space.intro')}
      breadcrumbs={spaceTrail(t, { slug: data.slug, name: data.name }, current)}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {data.role && <Badge variant="outline">{t(`roles.${data.role}`)}</Badge>}
          {abilities.createQuickRoom && <QuickRoomButton space={data} />}
          {abilities.createFixedRoom && <CreateFixedRoomDialog space={data} />}
        </div>
      }
    >
      <Tabs
        value={current}
        onValueChange={(value) =>
          void navigate({ search: { tab: value === 'rooms' ? undefined : (value as SpaceTab) } })
        }
      >
        <div className="-mx-4 [scrollbar-width:none] overflow-x-auto overflow-y-hidden px-4 md:mx-0 md:px-0">
          <TabsList>
            {tabs.map((name) => (
              <TabsTrigger key={name} value={name} data-tour={`space-tab-${name}`}>
                {t(`space.tabs.${name}`)}
                {name === 'requests' && <PendingCount spaceId={data.id} />}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="rooms" className="pt-4">
          <RoomsTab space={data} />
        </TabsContent>
        <TabsContent value="members" className="pt-4">
          <MembersTab space={data} selfId={me.user.id} />
        </TabsContent>
        {abilities.viewInvites && (
          <TabsContent value="invites" className="pt-4">
            <InvitesTab space={data} />
          </TabsContent>
        )}
        {abilities.decideJoinRequests && (
          <TabsContent value="requests" className="pt-4">
            <RequestsTab space={data} />
          </TabsContent>
        )}
        {abilities.viewStatus && (
          <TabsContent value="status" className="pt-4">
            <StatusTab space={data} />
          </TabsContent>
        )}
        <TabsContent value="settings" className="pt-4">
          <SettingsTab space={data} selfId={me.user.id} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function PendingCount({ spaceId }: { spaceId: string }) {
  const requests = useQuery(joinRequestsQuery(spaceId));
  const count = requests.data?.length ?? 0;
  if (count === 0) return null;
  return <Badge>{count}</Badge>;
}
