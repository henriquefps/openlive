// SPDX-License-Identifier: AGPL-3.0-only
import type { ClientKind, DeviceArch, DeviceOs, ProtocolVersion } from '@openlive/protocol';

/** What the Worker tells the UserHubDO about a new connection (hub/route.ts); trusted as is. */
export interface HubConnectContext {
  userId: string;
  /** Set when the caller is a paired helper (device token): hello must name this device. */
  deviceId?: string;
  /** The paired device as D1 knows it, for HelperInfo. */
  device?: HubDevice;
  /** Set when the caller is the mobile app: revoking its app token closes the socket. */
  appTokenId?: string;
}

export interface HubDevice {
  name: string;
  os: DeviceOs;
  arch: DeviceArch;
}

/** Per-connection identity, kept with serializeAttachment so it survives hibernation. */
export interface HubAttachment {
  connectionId: string;
  userId: string;
  deviceId?: string;
  device?: HubDevice;
  appTokenId?: string;
  /** Set once the client's hello was accepted; before that only hello is allowed. */
  hello?: {
    client: ClientKind;
    clientVersion: string;
    protocol: ProtocolVersion;
    tabId?: string;
  };
  /** Set when the server started closing this socket. */
  closing?: true;
}

/** A room or space socket the mobile app opened, remembered by the hub for revocation. */
export interface AppTarget {
  kind: 'room' | 'space';
  id: string;
}
