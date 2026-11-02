// SPDX-License-Identifier: AGPL-3.0-only
import type { LinkOptions } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import type { SpaceTab } from '../routes/space/tabs.ts';

// The breadcrumb trails of the pages below the top level. Each trail follows the route hierarchy;
// the last crumb is the current page and every other crumb links to its level. A crumb whose name
// is still loading has no label (the header shows a skeleton). Names come from queries the page
// already has, so a trail never costs a request.

export interface Crumb {
  /** The level's name; undefined while it loads. */
  label: string | undefined;
  /** Where the level lives; absent only on the current page. */
  link?: LinkOptions | undefined;
}

/** The level the back button goes to: the crumb before the current page. */
export const parentOf = (trail: readonly Crumb[]): Crumb | undefined =>
  trail.length > 1 ? trail[trail.length - 2] : undefined;

const spaces = (t: TFunction): Crumb => ({ label: t('app.nav.spaces'), link: { to: '/spaces' } });

/** Spaces › <Space> [› <Tab>]: the space page; the default rooms tab is the space itself. */
export function spaceTrail(
  t: TFunction,
  space: { slug: string; name: string | undefined },
  tab: SpaceTab = 'rooms',
): Crumb[] {
  const level: Crumb = {
    label: space.name,
    link: { to: '/s/$spaceSlug', params: { spaceSlug: space.slug } },
  };
  if (tab === 'rooms') return [spaces(t), { label: space.name }];
  return [spaces(t), level, { label: t(`space.tabs.${tab}`) }];
}

/**
 * Spaces › <Space> › <Room> [› <Streamer>]: a room, and its watch view. `space` is null for a guest
 * of a single room, who cannot see the space; the room then sits right under Spaces.
 */
export function roomTrail(
  t: TFunction,
  space: { slug: string; name: string | undefined } | null,
  /** `link` is needed only under a streamer, where the room is a level up. */
  room: { name: string | undefined; link?: LinkOptions | undefined },
  streamer?: { name: string | undefined },
): Crumb[] {
  const trail: Crumb[] = [spaces(t)];
  if (space) {
    trail.push({
      label: space.name,
      link: { to: '/s/$spaceSlug', params: { spaceSlug: space.slug } },
    });
  }
  if (streamer === undefined) return [...trail, { label: room.name }];
  return [...trail, { label: room.name, link: room.link }, { label: streamer.name }];
}

/** Platform › Settings, Platform › Setup, Platform › Users [› <User>]. */
export function platformTrail(
  t: TFunction,
  page: 'settings' | 'setup' | 'users',
  user?: { name: string | undefined },
): Crumb[] {
  const platform: Crumb = { label: t('admin.nav.platform'), link: { to: '/admin' } };
  const label = t(`app.breadcrumb.${page}`);
  if (page === 'users' && user) {
    return [platform, { label, link: { to: '/admin/users' } }, { label: user.name }];
  }
  return [platform, { label }];
}
