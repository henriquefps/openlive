// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';
import { apiGet, apiSend } from '../api/client.ts';
import { queryClient } from '../api/query-client.ts';

// The tutorial's progress per user: the screens already seen and the global off switch
// (GET/PUT /api/me/tutorial, D1 user_tutorial). A copy in localStorage renders the right thing
// at once on the next load; the API's answer replaces it. Storage can be unavailable, so every
// access is guarded.

export interface TutorialProgress {
  seen: string[];
  disabled: boolean;
}

const storageKey = (userId: string) => `openlive.tutorial.${userId}`;

function readCache(userId: string): TutorialProgress | undefined {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<TutorialProgress>;
    if (!Array.isArray(value.seen) || typeof value.disabled !== 'boolean') return undefined;
    return { seen: value.seen.filter((s) => typeof s === 'string'), disabled: value.disabled };
  } catch {
    return undefined;
  }
}

function writeCache(userId: string, value: TutorialProgress): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(value));
  } catch {
    // Then only the API keeps it.
  }
}

export const tutorialQuery = (userId: string) =>
  queryOptions({
    queryKey: ['me', 'tutorial', userId],
    queryFn: async () => {
      const value = (await apiGet<{ tutorial: TutorialProgress }>('/api/me/tutorial')).tutorial;
      writeCache(userId, value);
      return value;
    },
    // The cached copy renders at once and is refetched straight away.
    initialData: () => readCache(userId),
    initialDataUpdatedAt: 0,
    staleTime: 5 * 60_000,
  });

async function save(userId: string, value: TutorialProgress): Promise<void> {
  queryClient.setQueryData(tutorialQuery(userId).queryKey, value);
  writeCache(userId, value);
  await apiSend('PUT', '/api/me/tutorial', value);
}

const current = (userId: string): TutorialProgress =>
  queryClient.getQueryData(tutorialQuery(userId).queryKey) ?? { seen: [], disabled: false };

/** A screen's tutorial finished or was skipped: it does not run again. */
export function markSeen(userId: string, screen: string): Promise<void> {
  const now = current(userId);
  if (now.seen.includes(screen)) return Promise.resolve();
  return save(userId, { ...now, seen: [...now.seen, screen] });
}

/** "Don't show tutorials again". */
export function disableTutorials(userId: string, screen: string): Promise<void> {
  const now = current(userId);
  return save(userId, { seen: [...new Set([...now.seen, screen])], disabled: true });
}

/** Settings → Replay tutorial: every screen's tutorial runs again on the next visit. */
export function replayTutorials(userId: string): Promise<void> {
  return save(userId, { seen: [], disabled: false });
}
