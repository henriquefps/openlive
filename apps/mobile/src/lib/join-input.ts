// SPDX-License-Identifier: AGPL-3.0-only
import { parseScanned } from './deeplink.ts';

// What a person pastes or types to join something: an invite link or token, or the code of a quick
// room (OL-4821-0937, in any form people type it). Pure, so it is tested without a device.

const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** A quick room's code, with or without the OL prefix, hyphens or spaces. */
const ROOM_CODE = /^(?:OL)?[\s-]*(\d{4})[\s-]*(\d{4})$/i;

export type JoinInput =
  /** `instance` is set when the text named a server (a link), absent for a bare token. */
  | { kind: 'invite'; token: string; instance?: string }
  | { kind: 'code'; code: string; instance?: string }
  | { kind: 'unknown' };

/** The canonical form of a room code, or null when the text is not one. */
export function normalizeRoomCode(text: string): string | null {
  const match = ROOM_CODE.exec(text.trim());
  return match ? `OL-${match[1]}-${match[2]}` : null;
}

export function parseJoinInput(text: string): JoinInput {
  const value = text.trim();
  if (!value) return { kind: 'unknown' };
  if (INVITE_TOKEN.test(value)) return { kind: 'invite', token: value };
  const code = normalizeRoomCode(value);
  if (code) return { kind: 'code', code };
  // A join link of a server: /join/<code> (a quick room's shareable link).
  const joinLink = /^([a-z]+:\/\/[^/?#]+)\/join\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(value);
  if (joinLink?.[1] && joinLink[2]) {
    const linked = normalizeRoomCode(decodeURIComponent(joinLink[2]));
    const link = parseScanned(joinLink[1]);
    if (linked && link.kind === 'join')
      return { kind: 'code', code: linked, instance: link.instance };
    return { kind: 'unknown' };
  }
  const link = parseScanned(value);
  if (link.kind === 'join' && link.invite) {
    return { kind: 'invite', token: link.invite, instance: link.instance };
  }
  return { kind: 'unknown' };
}
