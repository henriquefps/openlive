// SPDX-License-Identifier: AGPL-3.0-only
import { spaceAbilities } from '@openlive/client';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { OfflineHint } from '../components/OfflineHint.tsx';
import { Screen } from '../components/ui.tsx';
import { SectionSelect } from '../components/ui/SectionSelect.tsx';
import { Skeleton } from '../components/ui/Skeleton.tsx';
import {
  backTarget,
  currentSection,
  isSpaceQuery,
  pendingDot,
  sectionItems,
  type SpaceSection,
  visibleSections,
} from '../lib/space-view.ts';
import { useJoinRequests, useSpace } from '../space-queries.ts';
import { useScope } from '../queries.ts';
import { InvitesSection } from './space/InvitesSection.tsx';
import { MembersSection } from './space/MembersSection.tsx';
import { RequestsSection } from './space/RequestsSection.tsx';
import { RoomsSection } from './space/RoomsSection.tsx';
import { SettingsSection } from './space/SettingsSection.tsx';
import { QueryFailure } from './space/shared.tsx';
import { StatusSection } from './space/StatusSection.tsx';

/**
 * A space, as the web's SpacePage: sections (Rooms, Members, Invites, Requests, Status, Settings;
 * the role decides which) in a switcher, the section on screen kept in the route. Pull down to
 * read the space's data again.
 */
export function SpaceScreen({
  origin,
  spaceId,
  spaceName,
  section,
  refreshKey,
  onSection,
  onBack,
  onOpenRoom,
}: {
  origin: string;
  spaceId: string;
  spaceName: string;
  /** The section the route asks for (absent: Rooms). */
  section: SpaceSection | undefined;
  /** Changes when a room was closed, so the unread counts are fetched again. */
  refreshKey: number;
  onSection: (section: SpaceSection) => void;
  onBack: () => void;
  onOpenRoom: (roomId: string, roomName: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const scope = useScope(origin);
  const space = useSpace(origin, spaceId);
  const data = space.data;
  const abilities = data ? spaceAbilities(data) : null;
  const requests = useJoinRequests(origin, spaceId, abilities?.decideJoinRequests === true);
  const pending = requests.data?.length ?? 0;

  // Pull to refresh: the spinner is the pull's own, not the background revalidation's.
  const [pulling, setPulling] = useState(false);
  const reload = () => {
    if (!scope) return;
    setPulling(true);
    void queryClient
      .refetchQueries({ predicate: (q) => isSpaceQuery(q.queryKey, scope, spaceId) })
      .finally(() => setPulling(false));
  };

  const sections = abilities ? visibleSections(abilities) : (['rooms'] as SpaceSection[]);
  const current = currentSection(sections, section);
  const goBack = () => (backTarget(current) === 'rooms' ? onSection('rooms') : onBack());
  const title = data?.name ?? spaceName;
  const shell = {
    title,
    subtitle: current === 'rooms' ? undefined : t(`space.tabs.${current}`),
    onBack: goBack,
    backLabel: current === 'rooms' ? t('app.nav.spaces') : title,
    refreshing: pulling,
    onRefresh: reload,
  };

  if (!data || !scope) {
    return (
      <Screen {...shell}>
        {space.isError ? (
          <QueryFailure error={space.error} onRetry={() => void space.refetch()} />
        ) : (
          <Skeleton height={160} />
        )}
      </Screen>
    );
  }
  const props = { origin, space: data, selfId: scope.userId };
  return (
    <Screen {...shell}>
      <OfflineHint hasData />
      <SectionSelect
        sections={sectionItems(sections, (s) => t(`space.tabs.${s}`), pending)}
        value={current}
        onChange={onSection}
        title={t('space.sectionLabel')}
        dot={pendingDot(sections, current, pending)}
      />
      {current === 'rooms' ? (
        <RoomsSection {...props} refreshKey={refreshKey} onOpenRoom={onOpenRoom} />
      ) : null}
      {current === 'members' ? <MembersSection {...props} /> : null}
      {current === 'invites' ? <InvitesSection {...props} /> : null}
      {current === 'requests' ? <RequestsSection {...props} /> : null}
      {current === 'status' ? <StatusSection {...props} /> : null}
      {current === 'settings' ? <SettingsSection {...props} onLeft={onBack} /> : null}
    </Screen>
  );
}
