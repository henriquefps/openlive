// SPDX-License-Identifier: AGPL-3.0-only
import type { Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

export function EmptyState({
  icon: IconComponent,
  title,
  description,
  heading: Heading = 'h2',
  children,
  'data-tour': tour,
}: {
  icon: Icon;
  /** A `data-tour` anchor for the tutorial (tutorial/steps.ts). */
  'data-tour'?: string;
  title: string;
  /** Heading level of the title: h1 when the empty state is the whole page. */
  heading?: 'h1' | 'h2';
  description: string;
  children?: ReactNode;
}) {
  return (
    <Empty className="border" data-tour={tour}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <IconComponent />
        </EmptyMedia>
        <EmptyTitle>
          <Heading>{title}</Heading>
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
