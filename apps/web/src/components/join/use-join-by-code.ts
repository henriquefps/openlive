// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ME_KEY } from '../../api/auth.ts';
import { joinRoomByCode } from '../../api/spaces.ts';

/**
 * Joins a quick room by code and opens it: members at the room's space URL, guests of that room
 * only at /rooms/:id, since they cannot see the space.
 */
export function useJoinByCode() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: joinRoomByCode,
    onSuccess: async ({ room, spaceSlug }) => {
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      await navigate(
        spaceSlug
          ? {
              to: '/s/$spaceSlug/r/$roomSlug',
              params: { spaceSlug, roomSlug: room.slug },
              replace: true,
            }
          : { to: '/rooms/$roomId', params: { roomId: room.id }, replace: true },
      );
    },
  });
}
