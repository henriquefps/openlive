// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ClientKind,
  ErrorPayload,
  Permissions,
  Role,
  RoomInfo,
  RoomSettings,
  StreamInfo,
} from '@openlive/protocol';

/**
 * Everything the RoomDO needs to know about a new connection. The Worker builds it after
 * authenticating the caller and checking can(actor, 'room.view'), and hands it to the DO on the
 * internal connect request (see room/route.ts). The DO trusts it as is.
 */
export interface ConnectContext {
  userId: string;
  /** Set when the caller is a paired helper (device token): hello must name this device. */
  deviceId?: string;
  /** Set when the caller is the mobile app: revoking its app token closes the socket. */
  appTokenId?: string;
  displayName: string;
  avatarUrl?: string;
  role: Role;
  permissions: Permissions;
  room: RoomInfo;
  settings: RoomSettings;
}

/** Per-connection identity, kept with serializeAttachment so it survives hibernation. */
export interface Attachment {
  connectionId: string;
  userId: string;
  /** The device token's device, for a helper connection. */
  deviceId?: string;
  /** The app token, for a mobile app connection. */
  appTokenId?: string;
  displayName: string;
  avatarUrl?: string;
  role: Role;
  permissions: Permissions;
  /** Set once the client's hello was accepted; before that only hello is allowed. */
  hello?: { client: ClientKind; deviceId?: string; tabId?: string };
  /** Set when the server started closing this socket; it no longer counts as present. */
  closing?: true;
}

/**
 * A stream as the room stores it: the StreamInfo every member sees, minus the live viewer count,
 * which the room computes from its slots. SFU details live apart (store.ts, stream_sfu).
 */
export type RoomStream = Omit<StreamInfo, 'viewerCount'>;

/** A user's live stream as the platform admin sees it: metadata only. */
export interface UserStreamInfo {
  streamId: string;
  preset: StreamInfo['preset'];
  sourceKind: StreamInfo['source']['kind'];
  startedAt: number;
  viewerCount: number;
}

/** The answer of a RoomDO SFU-proxy RPC: a value, or the error the REST route returns. */
export type RtcResult<T> =
  | { ok: true; status: 200 | 201 | 204; value: T }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 410 | 413 | 415 | 429 | 502 | 503;
      error: ErrorPayload;
    };
