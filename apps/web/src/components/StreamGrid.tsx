// SPDX-License-Identifier: AGPL-3.0-only
import { BroadcastIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from './EmptyState.tsx';
import { StreamCard, type StreamCardProps } from './StreamCard.tsx';

/** The room's live streams, one card each; the empty state when nobody is live. */
export function StreamGrid({
  streams,
  onOpen,
  onHover,
  selectedId = null,
}: {
  streams: readonly (StreamCardProps & { id: string })[];
  /** Makes the cards clickable: opens the stream's watch view. */
  onOpen?: (id: string) => void;
  /** The pointer rests on a card (true) or left it (false): pull on hover (rtc/prepull.ts). */
  onHover?: (id: string, hovering: boolean) => void;
  selectedId?: string | null;
}) {
  const { t } = useTranslation();
  if (streams.length === 0) {
    return (
      <EmptyState
        icon={BroadcastIcon}
        title={t('room.empty.title')}
        description={t('room.empty.description')}
      />
    );
  }
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-4">
      {streams.map(({ id, ...stream }) => (
        <li
          key={id}
          className="flex flex-col *:flex-1"
          {...(onHover
            ? {
                onPointerEnter: () => onHover(id, true),
                onPointerLeave: () => onHover(id, false),
              }
            : {})}
        >
          <StreamCard
            {...stream}
            {...(onOpen ? { onOpen: () => onOpen(id) } : {})}
            selected={id === selectedId}
          />
        </li>
      ))}
    </ul>
  );
}
