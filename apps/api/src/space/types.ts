// SPDX-License-Identifier: AGPL-3.0-only
import type { LivePresence, RoomVisibility, VoicePresence } from '@openlive/protocol';

/**
 * Which rooms of a space a subscriber may see in the sidebar (PROTOCOL.md 7.8), as can() decides
 * room.view: rooms with visibility `space` always; restricted ones all (`all`, managers) or those
 * of an active room_access grant.
 */
export interface PresenceAccess {
  all: boolean;
  /** Restricted rooms the user holds a view grant for; `expiresAt` null means until revoked. */
  restricted: { roomId: string; expiresAt: number | null }[];
}

/** What the Worker tells the SpaceDO about a new connection (space/route.ts); trusted as is. */
export interface SpaceConnectContext {
  userId: string;
  spaceId: string;
  access: PresenceAccess;
  /** Set when the caller is the mobile app: revoking its app token closes the socket. */
  appTokenId?: string;
}

/** Per-connection identity, kept with serializeAttachment so it survives hibernation. */
export interface SpaceAttachment extends SpaceConnectContext {
  connectionId: string;
  /** Set once the client's hello was accepted; before that only hello is allowed. */
  hello?: { tabId?: string };
  /** Set when the server started closing this socket. */
  closing?: true;
}

/** A RoomDO's summary as it pushes it to its SpaceDO: the RoomPresence plus its visibility. */
export interface RoomPresenceUpdate {
  roomId: string;
  visibility: RoomVisibility;
  voice: VoicePresence[];
  live: LivePresence[];
}
