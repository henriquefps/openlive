// SPDX-License-Identifier: AGPL-3.0-only
import { GearSixIcon, LightningIcon, SignInIcon, SignOutIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { logout, meQuery, type User } from '../api/auth.ts';
import { JoinCodeDialog } from './join/JoinCodeDialog.tsx';

export function UserAvatar({ user }: { user: User }) {
  return (
    <Avatar size="sm">
      {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
      <AvatarFallback>{user.displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

/** Top bar: the signed-in user's menu (Join with code, Settings, Log out), or a Sign in link. */
export function UserMenu() {
  const { t } = useTranslation();
  const me = useQuery(meQuery);
  const navigate = useNavigate();
  const onHome = useRouterState({ select: (state) => state.location.pathname === '/' });
  const [joinOpen, setJoinOpen] = useState(false);
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => navigate({ to: '/' }),
  });

  if (me.isPending) return null;
  if (!me.data) {
    if (onHome) return null;
    return (
      <Button asChild variant="outline">
        <Link to="/">
          <SignInIcon data-icon="inline-start" />
          {t('auth.signIn')}
        </Link>
      </Button>
    );
  }
  const { user } = me.data;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="px-1.5"
            aria-label={t('auth.menu', { name: user.displayName })}
          >
            <UserAvatar user={user} />
            <span className="hidden max-w-40 truncate md:inline">{user.displayName}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuLabel className="truncate">{user.displayName}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setJoinOpen(true)}>
            <LightningIcon />
            {t('join.title')}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/settings">
              <GearSixIcon />
              {t('app.nav.settings')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={signOut.isPending} onSelect={() => signOut.mutate()}>
            <SignOutIcon />
            {t('auth.logout')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <JoinCodeDialog open={joinOpen} onOpenChange={setJoinOpen} />
    </>
  );
}
