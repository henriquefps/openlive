// SPDX-License-Identifier: AGPL-3.0-only
import {
  DownloadSimpleIcon,
  GearSixIcon,
  ShieldCheckIcon,
  UserListIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { type Me, meQuery } from '../api/auth.ts';
import { QuotaBanner } from '../components/admin/QuotaBanner.tsx';
import { AppMark } from '../components/AppMark.tsx';
import { ShellBottomBars } from '../components/BottomBars.tsx';
import { unreadLabel, useTotalUnread } from '../chat/api.ts';
import { MentionNotices } from '../chat/MentionNotices.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import { SidebarRooms } from '../components/SidebarRooms.tsx';
import { ThemeMenu } from '../components/ThemeMenu.tsx';
import { UserMenu } from '../components/UserMenu.tsx';
import { useProfileLanguage } from '../i18n/use-profile-language.ts';
import { useTutorialScreen } from '../tutorial/context.ts';
import { TutorialProvider } from '../tutorial/TutorialProvider.tsx';
import { useIsMobile } from '../hooks/use-mobile.ts';
import { VoiceConnected } from '../voice/VoiceConnected.tsx';
import { VoiceSessionProvider } from '../voice/VoiceSessionProvider.tsx';
import { VoiceSinkRouting } from '../voice/VoiceSinkRouting.tsx';
import { HubNotices, NoticeProvider } from '../notices/AppNotices.tsx';

// Inset layout (hfps-app-ui "Surfaces"): the top bar and the sidebar sit on --background, and all
// content is one raised --card surface (SidebarInset). Below 768 px the sidebar is a sheet. The
// voice session lives here, so the voice goes on while the user browses (voice/session.ts): its
// "Voice connected" panel sits at the bottom of the sidebar, or above the bottom of the screen on
// phones. The sound notices (notices/) sit inside it, to watch the rooms the tab has open.
export function RootLayout() {
  const { t } = useTranslation();
  useProfileLanguage();
  const mobile = useIsMobile();
  return (
    <TooltipProvider delayDuration={300}>
      <VoiceSessionProvider>
        <NoticeProvider>
          <TutorialProvider>
            <SidebarProvider className="flex-col">
              <a
                href="#content"
                className="sr-only rounded-md bg-card px-3 py-2 text-sm focus-visible:not-sr-only focus-visible:absolute focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {t('app.skipToContent')}
              </a>
              <TopBar />
              <div className="flex flex-1">
                <AppSidebar />
                <SidebarInset
                  id="content"
                  tabIndex={-1}
                  className="m-2 mt-0 min-w-0 rounded-xl border bg-card shadow-xs outline-none md:peer-data-[variant=inset]:mt-0 md:peer-data-[variant=inset]:shadow-xs"
                >
                  <QuotaBanner />
                  <Outlet />
                  <ShellBottomBars show={mobile} />
                </SidebarInset>
              </div>
            </SidebarProvider>
          </TutorialProvider>
        </NoticeProvider>
      </VoiceSessionProvider>
      <Toaster />
    </TooltipProvider>
  );
}

function TopBar() {
  const { t } = useTranslation();
  const me = useQuery(meQuery);
  useTutorialScreen('topbar', Boolean(me.data));
  return (
    <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 bg-background px-2 md:px-4">
      <SidebarTrigger label={t('app.sidebar.toggle')} />
      <Link
        to="/"
        aria-label={t('app.home')}
        className="flex items-center gap-2 rounded-md px-1 text-base font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <AppMark />
        <span>{t('app.name')}</span>
      </Link>
      <div className="ml-auto flex items-center gap-1">
        <div className="flex items-center gap-1" data-tour="topbar-preferences">
          <LanguageSelect compact />
          <ThemeMenu />
        </div>
        <div className="flex" data-tour="topbar-user">
          <UserMenu />
        </div>
      </div>
      {/* Chat mentions from any room, wherever the user is (docs/PROTOCOL.md 7.6), and your
          own streams' notices from the hub. */}
      {me.data && <MentionNotices />}
      {me.data && <HubNotices />}
      {me.data && <VoiceSinkRouting />}
    </header>
  );
}

const NAV = [
  { to: '/spaces', key: 'spaces', icon: UsersThreeIcon, prefixes: ['/spaces', '/s/'] },
  { to: '/settings', key: 'settings', icon: GearSixIcon, prefixes: ['/settings'] },
  { to: '/download', key: 'download', icon: DownloadSimpleIcon, prefixes: ['/download'] },
] as const;

/** The platform admin's entry, or the claim page while the instance has no admin. */
function adminNav(me: Me | null | undefined) {
  if (me?.user.isPlatformAdmin) {
    return [
      {
        to: '/admin',
        label: 'admin.nav.platform',
        icon: ShieldCheckIcon,
        prefix: '/admin',
        exclude: '/admin/users',
      },
      { to: '/admin/users', label: 'admin.nav.users', icon: UserListIcon, prefix: '/admin/users' },
    ] as const;
  }
  if (me?.adminClaimable) {
    return [
      { to: '/admin/claim', label: 'admin.nav.claim', icon: ShieldCheckIcon, prefix: '/admin' },
    ] as const;
  }
  return [];
}

function AppSidebar() {
  const { t } = useTranslation();
  const { setOpenMobile, isMobile } = useSidebar();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const me = useQuery(meQuery);
  const unread = useTotalUnread();
  return (
    <Sidebar
      variant="inset"
      mobileTitle={t('app.sidebar.title')}
      className="top-(--header-height) h-[calc(100svh-var(--header-height))]! pt-0"
    >
      <SidebarContent>
        <SidebarGroup className="pt-0">
          <nav aria-label={t('app.nav.label')}>
            <SidebarMenu>
              {NAV.map(({ to, key, icon: Icon, prefixes }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    asChild
                    isActive={prefixes.some((prefix) => pathname.startsWith(prefix))}
                  >
                    <Link to={to} onClick={() => setOpenMobile(false)}>
                      <Icon />
                      <span>{t(`app.nav.${key}`)}</span>
                    </Link>
                  </SidebarMenuButton>
                  {key === 'spaces' && unread > 0 && (
                    <SidebarMenuBadge
                      aria-label={t('chat.unread', { count: unread })}
                      data-testid="nav-unread"
                    >
                      {unreadLabel(unread)}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
              {adminNav(me.data).map((item) => {
                const { to, label, icon: Icon, prefix } = item;
                const exclude = 'exclude' in item ? item.exclude : null;
                const active =
                  pathname.startsWith(prefix) && !(exclude && pathname.startsWith(exclude));
                return (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton asChild isActive={active}>
                      <Link to={to} onClick={() => setOpenMobile(false)}>
                        <Icon />
                        <span>{t(label)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
        <SidebarRooms pathname={pathname} onNavigate={() => setOpenMobile(false)} />
      </SidebarContent>
      {!isMobile && (
        <SidebarFooter className="empty:hidden">
          <VoiceConnected variant="sidebar" />
        </SidebarFooter>
      )}
    </Sidebar>
  );
}
