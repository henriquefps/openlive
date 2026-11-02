// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { meQuery } from '../../api/auth.ts';
import { spaceQuery } from '../../api/spaces.ts';

/**
 * The space behind a /s/:slug URL. The REST API addresses spaces by id; the caller's memberships
 * (GET /api/me) map their slugs to ids. Someone who is not a member gets `notFound`.
 */
export function useSpaceBySlug(slug: string) {
  const me = useQuery(meQuery);
  const spaceId = me.data?.memberships.find((m) => m.slug === slug)?.spaceId ?? null;
  const space = useQuery({ ...spaceQuery(spaceId ?? ''), enabled: spaceId !== null });
  return {
    me: me.data ?? null,
    space,
    isPending: me.isPending || (spaceId !== null && space.isPending),
    notFound: me.isSuccess && spaceId === null,
  };
}
