// SPDX-License-Identifier: AGPL-3.0-only
// The space page's tabs, apart from the page itself so the router can validate `?tab=` without
// loading the page's chunk.
export const SPACE_TABS = [
  'rooms',
  'members',
  'invites',
  'requests',
  'status',
  'settings',
] as const;
export type SpaceTab = (typeof SPACE_TABS)[number];
