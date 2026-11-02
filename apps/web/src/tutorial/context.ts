// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useEffect } from 'react';

export interface TutorialApi {
  /** The screen is on the page: run its tutorial if the user has not seen it. */
  request: (screen: string) => void;
  /** The screen left the page. */
  release: (screen: string) => void;
}

export const TutorialContext = createContext<TutorialApi | null>(null);

/**
 * Runs `screen`'s tutorial the first time the user opens it, once `ready` (its content, and so
 * the `data-tour` anchors, are rendered). Outside a TutorialProvider it does nothing.
 */
export function useTutorialScreen(screen: string, ready: boolean): void {
  const tutorial = useContext(TutorialContext);
  useEffect(() => {
    if (!tutorial || !ready) return;
    tutorial.request(screen);
    return () => tutorial.release(screen);
  }, [tutorial, screen, ready]);
}
