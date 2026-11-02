// SPDX-License-Identifier: AGPL-3.0-only
import { DotsThreeIcon } from '@phosphor-icons/react';
import { type ComponentProps, Fragment, type ReactNode, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useIsContainerAtLeast } from '@/hooks/use-container-width';
import { cn } from '@/lib/utils';
import { formatDate, formatRelativeDay } from '../i18n/format.ts';

/** The list container's `@xl` (36rem): the table from here up, cards below (phones). */
export const DATA_LIST_TABLE_MIN_WIDTH = 576;

/**
 * One data source, two renderings: the caller's table (unchanged) once the list container is
 * `@xl` wide or more, and a card list below it, with the same search, filters, sort and selection
 * because those live outside and feed `items`. No column header in card mode.
 */
export function DataList<T>({
  items,
  getKey,
  renderTable,
  renderCard,
  className,
  ...props
}: {
  items: readonly T[];
  getKey: (item: T) => string;
  /** The existing desktop table, rendered with the same items. */
  renderTable: (items: readonly T[]) => ReactNode;
  /** One card per item (see `DataCard`). */
  renderCard: (item: T) => ReactNode;
} & Omit<ComponentProps<'div'>, 'children'>) {
  const ref = useRef<HTMLDivElement>(null);
  const wide = useIsContainerAtLeast(ref, DATA_LIST_TABLE_MIN_WIDTH);
  return (
    <div
      ref={ref}
      data-mode={wide ? 'table' : 'cards'}
      className={cn('overflow-x-auto rounded-lg border', className)}
      {...props}
    >
      {wide ? (
        renderTable(items)
      ) : (
        <ul>
          {items.map((item) => (
            <li key={getKey(item)} className="border-b last:border-b-0">
              {renderCard(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A row of the card list: label (up to two lines) with the status on the right, a muted meta
 * line below. The whole item is tappable; `actions` (a `DataCardActions`) sit beside it.
 */
export function DataCard({
  title,
  badge,
  meta,
  selected = false,
  onOpen,
  wrap,
  actions,
  children,
  ...props
}: {
  title: ReactNode;
  badge?: ReactNode;
  /** Meta values, joined with " · ": the mono id first, then the two or three most useful. */
  meta?: ReactNode[];
  selected?: boolean;
  onOpen?: () => void;
  /** Make the whole item something else, e.g. a router link. */
  wrap?: ((content: ReactNode, className: string) => ReactNode) | undefined;
  actions?: ReactNode;
  /** Extra content under the meta line, e.g. a progress bar. */
  children?: ReactNode;
} & Omit<ComponentProps<'div'>, 'title'>) {
  const shown = (meta ?? []).filter((m) => m !== null && m !== undefined && m !== false);
  const content = (
    <>
      <span className="flex items-start justify-between gap-3">
        <span className="line-clamp-2 min-w-0 text-[0.9375rem] font-medium [overflow-wrap:anywhere]">
          {title}
        </span>
        {badge && <span className="shrink-0">{badge}</span>}
      </span>
      {shown.length > 0 && (
        <span className="flex flex-wrap items-baseline text-[0.8125rem] text-muted-foreground">
          {shown.map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static, ordered meta values
            <Fragment key={i}>
              {i > 0 && <span aria-hidden="true">&nbsp;·&nbsp;</span>}
              {m}
            </Fragment>
          ))}
        </span>
      )}
      {children}
    </>
  );
  const mainClass = cn(
    'flex min-h-14 min-w-0 flex-1 flex-col gap-1 py-3 pl-4 text-left',
    actions ? 'pr-2' : 'pr-4',
    onOpen &&
      'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
  );
  const main = wrap ? (
    wrap(content, mainClass)
  ) : onOpen ? (
    <button type="button" className={mainClass} onClick={onOpen}>
      {content}
    </button>
  ) : (
    <div className={mainClass}>{content}</div>
  );
  return (
    <div
      data-state={selected ? 'selected' : undefined}
      className={cn(
        'flex items-center',
        selected ? 'bg-muted shadow-[inset_2px_0_0_var(--primary)]' : 'hover:bg-muted/50',
      )}
      {...props}
    >
      {main}
      {actions && <div className="shrink-0 pr-3">{actions}</div>}
    </div>
  );
}

/** Row actions on a card: a "⋯" icon button (h-9) opening a menu. Children are menu items. */
export function DataCardActions({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9" aria-label={label}>
          <DotsThreeIcon weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

const FULL_DATE: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

/** A relative date without time ("3 days ago", "Oct 24"), the full date and time in `title`. */
export function RelativeDate({ value, locale }: { value: number; locale: string }) {
  return (
    <time dateTime={new Date(value).toISOString()} title={formatDate(value, locale, FULL_DATE)}>
      {formatRelativeDay(value, locale)}
    </time>
  );
}
