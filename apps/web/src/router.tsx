// SPDX-License-Identifier: AGPL-3.0-only
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type ParsedLocation,
  redirect,
} from '@tanstack/react-router';
import { USER_FILTERS, type UserFilter } from './api/admin.ts';
import { meQuery } from './api/auth.ts';
import { queryClient } from './api/query-client.ts';
import { NotFoundPage } from './routes/NotFoundPage.tsx';
import { RootLayout } from './routes/RootLayout.tsx';
import { SPACE_TABS, type SpaceTab } from './routes/space/tabs.ts';

// Code-based routes: few enough that a generator plugin is not worth it yet. The route tree, its
// guards and search validation load with the app; each page loads with its route, in its own
// chunk, so the first load only carries the layout and the page it opens.
const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

export interface HomeSearch {
  /** Where to go after signing in (set by the route guard). */
  returnTo?: string | undefined;
  /** An error code from a failed Discord or e-mail login, sent back by the API. */
  authError?: string | undefined;
  /** `link_offer`: the Discord account's e-mail already has an account. */
  auth?: string | undefined;
}

const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined);

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: lazyRouteComponent(() => import('./routes/HomePage.tsx'), 'HomePage'),
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    returnTo: optionalString(search['returnTo']),
    authError: optionalString(search['authError']),
    auth: optionalString(search['auth']),
  }),
});

/** Route guard: anonymous visitors go to Home, which signs them in and brings them back. */
async function requireSignedIn({ location }: { location: ParsedLocation }) {
  const me = await queryClient.ensureQueryData(meQuery).catch(() => null);
  if (!me) throw redirect({ to: '/', search: { returnTo: location.href } });
}
const spacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/spaces',
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(() => import('./routes/SpacesPage.tsx'), 'SpacesPage'),
});
const spaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/s/$spaceSlug',
  beforeLoad: requireSignedIn,
});
const spaceIndexRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: '/',
  component: lazyRouteComponent(() => import('./routes/SpacePage.tsx'), 'SpacePage'),
  validateSearch: (search: Record<string, unknown>): { tab?: SpaceTab | undefined } => ({
    tab: SPACE_TABS.find((tab) => tab === search['tab']),
  }),
});
export interface RoomSearch {
  /** The stream open in the watch view, inline on the room page (keeps the room socket). */
  watch?: string | undefined;
}
const roomSearch = (search: Record<string, unknown>): RoomSearch => ({
  watch: optionalString(search['watch']),
});

const roomRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: '/r/$roomSlug',
  component: lazyRouteComponent(() => import('./routes/RoomPage.tsx'), 'RoomPage'),
  validateSearch: roomSearch,
});
/** A room by id: for guests of a single room, who cannot see the space. */
const roomByIdRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/rooms/$roomId',
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(() => import('./routes/RoomPage.tsx'), 'RoomByIdPage'),
  validateSearch: roomSearch,
});
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(() => import('./routes/InvitePage.tsx'), 'InvitePage'),
});
/** /join/:code, the shareable link of a quick room. */
const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/join/$code',
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(() => import('./routes/JoinPage.tsx'), 'JoinPage'),
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(() => import('./routes/SettingsPage.tsx'), 'SettingsPage'),
});
/** /link?code=K7F-2QM: approve a helper's pairing. */
const linkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/link',
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(() => import('./routes/LinkPage.tsx'), 'LinkPage'),
  validateSearch: (search: Record<string, unknown>): { code?: string | undefined } => ({
    code: optionalString(search['code']),
  }),
});
/**
 * /app/authorize?client=…&redirect_uri=openlive://auth&…: the mobile app's login asks the
 * signed-in person to allow it. The route guard keeps the whole query through login.
 */
const appAuthorizeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/app/authorize',
  beforeLoad: requireSignedIn,
  // The page reads the raw query (searchStr): the router's search parser turns JSON-looking
  // values such as state=123 into numbers.
  component: lazyRouteComponent(() => import('./routes/AppAuthorizePage.tsx'), 'AppAuthorizePage'),
});
const loginVerifyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login/verify',
  component: lazyRouteComponent(() => import('./routes/LoginVerifyPage.tsx'), 'LoginVerifyPage'),
  validateSearch: (search: Record<string, unknown>): { token?: string | undefined } => ({
    token: optionalString(search['token']),
  }),
});

/** Platform admin pages: others go to the claim page while there is no admin yet. */
async function requirePlatformAdmin({ location }: { location: ParsedLocation }) {
  const me = await queryClient.ensureQueryData(meQuery).catch(() => null);
  if (!me) throw redirect({ to: '/', search: { returnTo: location.href } });
  if (!me.user.isPlatformAdmin) throw redirect({ to: me.adminClaimable ? '/admin/claim' : '/' });
}
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  beforeLoad: requirePlatformAdmin,
  component: lazyRouteComponent(
    () => import('./routes/admin/AdminOverviewPage.tsx'),
    'AdminOverviewPage',
  ),
});
const adminSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/settings',
  beforeLoad: requirePlatformAdmin,
  component: lazyRouteComponent(
    () => import('./routes/admin/AdminSettingsPage.tsx'),
    'AdminSettingsPage',
  ),
});
export interface AdminUsersSearch {
  /** The list filter (all when absent). */
  filter?: UserFilter | undefined;
  /** The search text. */
  q?: string | undefined;
  /** The account open in the detail sheet. */
  user?: string | undefined;
}
/** Every account, its spaces, and the platform-wide ban and deletion. */
const adminUsersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/users',
  beforeLoad: requirePlatformAdmin,
  component: lazyRouteComponent(
    () => import('./routes/admin/AdminUsersPage.tsx'),
    'AdminUsersPage',
  ),
  validateSearch: (search: Record<string, unknown>): AdminUsersSearch => ({
    filter: USER_FILTERS.find((f) => f !== 'all' && f === search['filter']),
    q: optionalString(search['q']),
    user: optionalString(search['user']),
  }),
});
/** The onboarding wizard. */
const adminSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/setup',
  beforeLoad: requirePlatformAdmin,
  component: lazyRouteComponent(
    () => import('./routes/admin/AdminSetupPage.tsx'),
    'AdminSetupPage',
  ),
});
const adminClaimRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/claim',
  beforeLoad: async (ctx) => {
    await requireSignedIn(ctx);
    const me = await queryClient.ensureQueryData(meQuery).catch(() => null);
    if (me?.user.isPlatformAdmin) throw redirect({ to: '/admin' });
  },
  component: lazyRouteComponent(
    () => import('./routes/admin/AdminClaimPage.tsx'),
    'AdminClaimPage',
  ),
});
const downloadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/download',
  component: lazyRouteComponent(() => import('./routes/DownloadPage.tsx'), 'DownloadPage'),
});

// Design system fixtures: only outside production builds (`vite` dev server, tests, or
// `vite build --mode development`). A production build drops the route and its chunk.
const devRoutes =
  import.meta.env.MODE === 'production'
    ? []
    : [
        createRoute({
          getParentRoute: () => rootRoute,
          path: '/dev/components',
          component: lazyRouteComponent(
            () => import('./routes/dev/ComponentsPage.tsx'),
            'ComponentsPage',
          ),
        }),
        createRoute({
          getParentRoute: () => rootRoute,
          path: '/dev/player',
          component: lazyRouteComponent(() => import('./routes/dev/PlayerPage.tsx'), 'PlayerPage'),
        }),
      ];

export const routeTree = rootRoute.addChildren([
  homeRoute,
  spacesRoute,
  spaceRoute.addChildren([spaceIndexRoute, roomRoute]),
  roomByIdRoute,
  inviteRoute,
  joinRoute,
  settingsRoute,
  linkRoute,
  loginVerifyRoute,
  appAuthorizeRoute,
  adminRoute,
  adminSettingsRoute,
  adminUsersRoute,
  adminSetupRoute,
  adminClaimRoute,
  downloadRoute,
  ...devRoutes,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
