// SPDX-License-Identifier: AGPL-3.0-only
import { CheckCircleIcon, EnvelopeOpenIcon, HourglassIcon } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { meQuery } from '../api/auth.ts';
import { ApiError, errorBodyOf } from '../api/client.ts';
import { type AcceptResult, invitePreviewQuery, useAcceptInvite } from '../api/spaces.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { OpenInApp } from '../components/OpenInApp.tsx';
import { Page } from '../components/Page.tsx';
import { ErrorText } from '../components/QueryError.tsx';
import { translateError } from '../i18n/errors.ts';
import { formatDate } from '../i18n/format.ts';

const route = getRouteApi('/invite/$token');

/** /invite/:token: what the invite gives, then accept. */
export function InvitePage() {
  const { t, i18n } = useTranslation();
  const { token } = route.useParams();
  const preview = useQuery(invitePreviewQuery(token));
  const accept = useAcceptInvite();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const locale = i18n.resolvedLanguage ?? i18n.language;

  const onAccepted = async (result: AcceptResult) => {
    if (result.status === 'pending') return;
    if (result.roomId) {
      await navigate({ to: '/rooms/$roomId', params: { roomId: result.roomId } });
      return;
    }
    const me = await queryClient.fetchQuery(meQuery);
    const space = me?.memberships.find((m) => m.spaceId === result.spaceId);
    await navigate(
      space ? { to: '/s/$spaceSlug', params: { spaceSlug: space.slug } } : { to: '/spaces' },
    );
  };

  if (preview.isPending) {
    return (
      <Page title={t('invite.title')}>
        <Skeleton className="h-40 w-full max-w-lg" />
      </Page>
    );
  }
  if (preview.isError) {
    const gone = preview.error instanceof ApiError && preview.error.status === 410;
    return (
      <Page title={t('invite.title')}>
        <EmptyState
          icon={EnvelopeOpenIcon}
          title={gone ? t('invite.unusable') : t('invite.notFound')}
          description={translateError(errorBodyOf(preview.error), t)}
        >
          <Button variant="outline" asChild>
            <Link to="/spaces">{t('invite.toSpaces')}</Link>
          </Button>
        </EmptyState>
      </Page>
    );
  }

  const { invite } = preview.data;
  const pending = preview.data.pending || accept.data?.status === 'pending';
  const place = invite.roomName
    ? t('invite.room', { room: invite.roomName, space: invite.spaceName })
    : invite.spaceName;

  if (pending) {
    return (
      <Page title={t('invite.title')}>
        <EmptyState
          icon={HourglassIcon}
          title={t('invite.pending.title')}
          description={t('invite.pending.description', { place })}
        >
          <Button variant="outline" asChild>
            <Link to="/spaces">{t('invite.toSpaces')}</Link>
          </Button>
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page title={t('invite.title')} description={t('invite.intro')}>
      <OpenInApp inviteToken={token} />
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{t('invite.joining', { place })}</CardTitle>
          <CardDescription>
            {t(invite.roomName ? 'invite.asRoomGuest' : `invite.as.${invite.role}`)}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex flex-col gap-2 text-[0.9375rem]">
            {invite.canStream && (
              <li className="flex items-center gap-2">
                <CheckCircleIcon className="text-primary" aria-hidden />
                {t('invite.canStream')}
              </li>
            )}
            {invite.requiresApproval && (
              <li className="flex items-center gap-2">
                <HourglassIcon className="text-muted-foreground" aria-hidden />
                {t('invite.needsApproval')}
              </li>
            )}
            <li className="text-[0.8125rem] text-muted-foreground">
              {t('invite.expires', {
                date: formatDate(invite.expiresAt, locale, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </li>
          </ul>
          <ErrorText error={accept.error} />
          <div className="flex gap-2">
            <Button
              disabled={accept.isPending}
              onClick={() => accept.mutate(token, { onSuccess: (r) => void onAccepted(r) })}
            >
              {accept.isPending && <Spinner data-icon="inline-start" />}
              {invite.requiresApproval ? t('invite.request') : t('invite.accept')}
            </Button>
            <Button variant="outline" asChild>
              <Link to="/spaces">{t('invite.decline')}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </Page>
  );
}
