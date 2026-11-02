// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { meQuery } from '../api/auth.ts';
import { TutorialContext } from './context.ts';
import { disableTutorials, markSeen, tutorialQuery } from './state.ts';
import { presentSteps, SCREEN_ORDER, stepsFor, type TutorialStep } from './steps.ts';
import { TutorialTour } from './TutorialTour.tsx';

// Runs one screen's tutorial at a time. Screens on the page say so with useTutorialScreen once
// their content is rendered; the first one not seen yet runs, unless tutorials are off. Steps
// whose anchor is not on the page are skipped. A replay (seen emptied) runs the screens that are
// on the page again straight away.

interface Active {
  screen: string;
  steps: TutorialStep[];
  index: number;
}

const order = (screen: string) => SCREEN_ORDER[screen] ?? 0;

export function TutorialProvider({ children }: { children: ReactNode }) {
  const me = useQuery(meQuery);
  const userId = me.data?.user.id ?? null;
  const progress = useQuery({ ...tutorialQuery(userId ?? ''), enabled: userId !== null });
  /** Screens on the page now. */
  const [mounted, setMounted] = useState<string[]>([]);
  /** Screens on the page whose steps had no anchor: not retried until they mount again. */
  const [empty, setEmpty] = useState<string[]>([]);
  const [active, setActive] = useState<Active | null>(null);

  const request = useCallback((screen: string) => {
    setMounted((m) => (m.includes(screen) ? m : [...m, screen]));
  }, []);
  const release = useCallback((screen: string) => {
    setMounted((m) => m.filter((s) => s !== screen));
    setEmpty((e) => e.filter((s) => s !== screen));
    // Leaving the screen mid-tour ends it without marking it seen: it runs on the next visit.
    setActive((a) => (a?.screen === screen ? null : a));
  }, []);
  const context = useMemo(() => ({ request, release }), [request, release]);

  const data = userId !== null ? progress.data : undefined;
  const next =
    active || !data || data.disabled
      ? undefined
      : mounted
          .filter((s) => !data.seen.includes(s) && !empty.includes(s))
          .sort((a, b) => order(a) - order(b))[0];
  useEffect(() => {
    if (!next) return;
    // On the next frame, so the screen that asked has laid out its anchors.
    const frame = requestAnimationFrame(() => {
      const steps = presentSteps(stepsFor(next));
      if (steps.length > 0) setActive({ screen: next, steps, index: 0 });
      else setEmpty((e) => [...e, next]);
    });
    return () => cancelAnimationFrame(frame);
  }, [next]);

  const finish = (disable = false) => {
    if (!active || userId === null) return;
    const save = disable
      ? disableTutorials(userId, active.screen)
      : markSeen(userId, active.screen);
    // A failed save only means the tutorial may show once more.
    save.catch(() => undefined);
    setActive(null);
  };

  return (
    <TutorialContext.Provider value={context}>
      {children}
      {active && (
        <TutorialTour
          key={active.screen}
          steps={active.steps}
          index={active.index}
          onIndex={(index) => setActive({ ...active, index })}
          onDone={() => finish()}
          onDisable={() => finish(true)}
        />
      )}
    </TutorialContext.Provider>
  );
}
