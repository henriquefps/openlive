// SPDX-License-Identifier: AGPL-3.0-only
import type { KickReason, RoomCloseReason, RoomVisibility } from '@openlive/protocol';
import { openRoomIds } from '../db/rooms';
import { roomAccess, roomSettings } from '../room/access';

// After D1 changes someone's role or room access, their open sockets follow at once
//: each affected RoomDO re-reads the person's access through the same
// roomAccess()/can() path the socket upgrade uses.

/** What happens to sockets of someone who can no longer see a room. */
export type OnLoss =
  /** Kicked (close 4004) with this reason: removal, ban, demotion, a room-only guest's revocation. */
  | KickReason
  /** Lost view of a restricted room while still in the space: forbidden, close 4003. */
  | 'revoke';

function stub(env: Env, roomId: string) {
  return env.ROOM.get(env.ROOM.idFromName(roomId));
}

/**
 * Tells the rooms (all open rooms of the space unless `roomIds` is given) about `userId`'s new
 * access: permissions.changed where they can still enter, a kick or revocation where they cannot.
 */
export async function syncUser(
  env: Env,
  spaceId: string,
  userId: string,
  onLoss: OnLoss,
  roomIds?: string[],
  now: number = Date.now(),
): Promise<void> {
  const rooms = roomIds ?? (await openRoomIds(env.DB, spaceId, now));
  // The space sidebar's subscribers reload what they may see (PROTOCOL.md 7.8).
  const space = env.SPACE.get(env.SPACE.idFromName(spaceId)).accessChanged(spaceId, userId);
  await Promise.all([
    space,
    ...rooms.map(async (roomId) => {
      const access = await roomAccess(env.DB, roomId, userId, now);
      if (access.ok) {
        const { role, permissions } = access.context;
        await stub(env, roomId).permissionsChanged(userId, { role, permissions });
      } else if (
        access.code === 'room_closed' ||
        access.code === 'room_not_found' ||
        access.code === 'space_suspended'
      ) {
        // Closing a room (or suspending its space) is announced by closeRoom.
      } else if (onLoss === 'revoke') {
        await stub(env, roomId).revokeAccess(userId);
      } else {
        await stub(env, roomId).kick(userId, onLoss);
      }
    }),
  ]);
}

/** A room's visibility changed in D1: its presence in the space sidebar follows (PROTOCOL.md 7.8). */
export async function syncRoomVisibility(
  env: Env,
  roomId: string,
  visibility: RoomVisibility,
): Promise<void> {
  await stub(env, roomId).visibilityChanged(visibility);
}

/** Closes rooms for everyone (room.closed, then close 4005). */
export async function closeRooms(
  env: Env,
  roomIds: string[],
  reason: RoomCloseReason,
): Promise<void> {
  await Promise.all(roomIds.map((roomId) => stub(env, roomId).closeRoom(reason)));
}

export async function setRoomExpiry(env: Env, roomId: string, expiresAt: number): Promise<void> {
  await stub(env, roomId).setExpiry(expiresAt);
}

/**
 * After a room's effective settings changed in D1 (its own, its space's or the platform's), each
 * open room takes the new settings: room.updated to everyone, and live streams end if the stream
 * capability is now off.
 */
export async function syncRoomSettings(env: Env, roomIds: string[]): Promise<void> {
  await Promise.all(
    roomIds.map(async (roomId) => {
      const settings = await roomSettings(env.DB, roomId);
      if (settings) await stub(env, roomId).settingsChanged(settings);
    }),
  );
}
