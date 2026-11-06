// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { joinRequestsQuery } from '../../api/spaces.ts';
import type { SpaceTab } from './tabs.ts';

/** The number of pending join requests, or 0 while loading. */
function usePendingCount(spaceId: string) {
  const requests = useQuery(joinRequestsQuery(spaceId));
  return requests.data?.length ?? 0;
}

export function PendingCount({ spaceId }: { spaceId: string }) {
  const count = usePendingCount(spaceId);
  if (count === 0) return null;
  return <Badge>{count}</Badge>;
}

/**
 * The space page's section switcher. Must sit in a container-query context (`@container`): from
 * `@2xl` up it is the tab strip; below, a full-width Select, so no section is hidden off-screen on
 * a phone. Both must be rendered inside the page's `<Tabs>` (the TabsList needs it); the Select
 * only calls `onChange`, which drives the same value.
 */
export function SpaceSectionSwitcher({
  tabs,
  current,
  spaceId,
  onChange,
}: {
  tabs: readonly SpaceTab[];
  current: SpaceTab;
  spaceId: string;
  onChange: (tab: SpaceTab) => void;
}) {
  const { t } = useTranslation();
  const pending = usePendingCount(spaceId);
  // A dot on the trigger when the requests section has items but is not the one on screen.
  const hiddenPending = pending > 0 && current !== 'requests' && tabs.includes('requests');
  return (
    <>
      <TabsList className="hidden @2xl:inline-flex">
        {tabs.map((name) => (
          <TabsTrigger key={name} value={name} data-tour={`space-tab-${name}`}>
            {t(`space.tabs.${name}`)}
            {name === 'requests' && <PendingCount spaceId={spaceId} />}
          </TabsTrigger>
        ))}
      </TabsList>
      <Select value={current} onValueChange={(value) => onChange(value as SpaceTab)}>
        <SelectTrigger
          className="relative w-full @2xl:hidden"
          aria-label={t('space.sectionLabel')}
          data-tour="space-section-select"
        >
          <SelectValue />
          {hiddenPending && (
            <span
              data-testid="space-section-pending-dot"
              title={t('space.tabs.requests')}
              className="absolute top-1 right-1 size-2 rounded-full bg-primary"
            />
          )}
        </SelectTrigger>
        <SelectContent>
          {tabs.map((name) => (
            <SelectItem key={name} value={name} data-tour={`space-tab-${name}-item`}>
              {t(`space.tabs.${name}`)}
              {name === 'requests' && <PendingCount spaceId={spaceId} />}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
