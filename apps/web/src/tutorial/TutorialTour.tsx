// SPDX-License-Identifier: AGPL-3.0-only
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useIsMobile } from '../hooks/use-mobile.ts';
import { anchorOf, type TutorialStep } from './steps.ts';

// One screen's tour: a dim backdrop with a ring around the current step's anchor, and the step
// in a Popover beside it (a bottom Sheet below 768 px). Esc skips, the arrow keys step through.

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(REDUCED_MOTION);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

/** The anchor's box, kept current while the page scrolls or resizes. */
function useRect(el: HTMLElement | null): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    const update = () => setRect(el.getBoundingClientRect());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      observer.disconnect();
    };
  }, [el]);
  return el ? rect : null;
}

/** The next step at or after `from` (or before, going back) whose anchor is on the page. */
function findPresent(steps: readonly TutorialStep[], from: number, direction: 1 | -1): number {
  for (let i = from; i >= 0 && i < steps.length; i += direction) {
    const s = steps[i];
    if (s && anchorOf(s)) return i;
  }
  return -1;
}

export function TutorialTour({
  steps,
  index,
  onIndex,
  onDone,
  onDisable,
}: {
  steps: readonly TutorialStep[];
  index: number;
  onIndex: (index: number) => void;
  /** Finished or skipped: this screen is seen. */
  onDone: () => void;
  /** "Don't show tutorials again". */
  onDisable: () => void;
}) {
  const { t } = useTranslation();
  // Step copy keys are registered at run time (steps.ts), so they are plain strings here; the
  // tutorial test checks that every one exists in both locales.
  const copy = t as unknown as (key: string) => string;
  const isMobile = useIsMobile();
  const reducedMotion = usePrefersReducedMotion();
  const titleId = useId();
  const bodyId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const step = steps[index];
  // The tour starts with steps whose anchor is on the page (TutorialProvider), so it is there now.
  const anchor = useMemo(() => (step ? anchorOf(step) : null), [step]);
  const rect = useRect(anchor);

  const next = () => {
    const at = findPresent(steps, index + 1, 1);
    if (at === -1) onDone();
    else onIndex(at);
  };
  const back = () => {
    const at = findPresent(steps, index - 1, -1);
    if (at !== -1) onIndex(at);
  };

  // Find the step's anchor; one that left the page since the tour started is skipped.
  useLayoutEffect(() => {
    if (!step) return;
    if (!anchor) {
      const at = findPresent(steps, index + 1, 1);
      if (at === -1) onDone();
      else onIndex(at);
      return;
    }
    anchor.scrollIntoView?.({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
    // Only when the step changes; the callbacks are new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, anchor]);

  // Keep focus on the step's main action, also when the step changes inside the same popover.
  useEffect(() => {
    primary.current?.focus();
  }, [step, anchor]);

  const virtualRef = useMemo(() => ({ current: anchor ?? document.body }), [anchor]);
  if (!step || !anchor) return null;

  const last = findPresent(steps, index + 1, 1) === -1;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      next();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      back();
    }
  };
  const position = t('tutorial.progress', { current: index + 1, total: steps.length });

  const dots = (
    <div className="flex items-center gap-1.5">
      <span className="sr-only">{position}</span>
      {steps.map((s, i) => (
        <span
          key={s.id}
          aria-hidden
          className={cn(
            'size-1.5 rounded-full',
            i === index ? 'bg-primary' : 'bg-muted-foreground/40',
          )}
        />
      ))}
    </div>
  );
  const actions = (
    <div className="flex items-center gap-2">
      {index > 0 && (
        <Button variant="outline" onClick={back}>
          {t('tutorial.back')}
        </Button>
      )}
      <Button ref={primary} onClick={next}>
        {last ? t('tutorial.done') : t('tutorial.next')}
      </Button>
    </div>
  );
  const skips = (
    <div className="flex flex-wrap items-center justify-between gap-x-4">
      <Button variant="link" className="h-auto px-0" onClick={onDone}>
        {t('tutorial.skip')}
      </Button>
      <Button variant="link" className="h-auto px-0 text-muted-foreground" onClick={onDisable}>
        {t('tutorial.disable')}
      </Button>
    </div>
  );
  const shared = {
    'aria-labelledby': titleId,
    'aria-describedby': bodyId,
    onKeyDown,
    onOpenAutoFocus: (event: Event) => {
      event.preventDefault();
      primary.current?.focus();
    },
    onInteractOutside: (event: Event) => event.preventDefault(),
  };

  return (
    <>
      <div className="fixed inset-0 z-40" data-slot="tutorial-backdrop" aria-hidden>
        {rect && (
          <div
            className="pointer-events-none fixed rounded-lg ring-2 ring-primary motion-safe:transition-all motion-safe:duration-200"
            style={{
              top: rect.top - 4,
              left: rect.left - 4,
              width: rect.width + 8,
              height: rect.height + 8,
              boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.45)',
            }}
          />
        )}
      </div>
      {isMobile ? (
        <Sheet open modal={false} onOpenChange={(open) => !open && onDone()}>
          <SheetContent
            side="bottom"
            showCloseButton={false}
            className="rounded-t-xl motion-reduce:animate-none"
            {...shared}
          >
            <SheetHeader className="pb-0">
              <SheetTitle id={titleId}>{copy(step.titleKey)}</SheetTitle>
              <SheetDescription id={bodyId} className="text-[0.9375rem]">
                {copy(step.bodyKey)}
              </SheetDescription>
            </SheetHeader>
            <SheetFooter className="pt-0">
              <div className="flex items-center justify-between gap-2">
                {dots}
                {actions}
              </div>
              {skips}
            </SheetFooter>
          </SheetContent>
        </Sheet>
      ) : (
        <Popover open modal onOpenChange={(open) => !open && onDone()}>
          <PopoverAnchor virtualRef={virtualRef} />
          <PopoverContent
            side={step.placement}
            sideOffset={12}
            collisionPadding={16}
            className="w-80 max-w-[calc(100vw-2rem)] gap-3 motion-reduce:animate-none"
            {...shared}
          >
            <div className="flex flex-col gap-1">
              <h2 id={titleId} className="text-[0.9375rem] font-semibold">
                {copy(step.titleKey)}
              </h2>
              <p id={bodyId} className="text-sm text-muted-foreground">
                {copy(step.bodyKey)}
              </p>
            </div>
            <div className="flex items-center justify-between gap-2">
              {dots}
              {actions}
            </div>
            {skips}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}
