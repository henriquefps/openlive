// SPDX-License-Identifier: AGPL-3.0-only
import { canManageRoom, isManager } from '@openlive/client';
import type { ChatRetentionDays, Role, RoomCapabilities } from '@openlive/protocol';
import {
  aboveCeiling,
  isValidCapabilities,
  sameCapabilities,
  type Template,
  type TemplateId,
  TEMPLATES,
} from './capabilities.ts';

// What the room screen's menu offers (the web's RoomView header): the same permissions through the
// abilities helpers of @openlive/client. The API decides; this only hides what would be refused.

export interface RoomMenu {
  /** A quick room's code and join link to copy or share. */
  code: boolean;
  /** Capabilities and chat settings: owners and admins. */
  features: boolean;
  /** Who sees a restricted room. */
  access: boolean;
  /** Archive a fixed room or end a quick one. */
  close: boolean;
  /** Nothing to offer: the menu button is not shown. */
  empty: boolean;
}

export function roomMenu(input: {
  role: Role | null | undefined;
  selfId: string;
  room: {
    kind: 'fixed' | 'quick';
    createdBy: string | null;
    visibility: string;
    code: string | null;
  };
  /** The room has ended: only the code stays out of reach too. */
  ended: boolean;
}): RoomMenu {
  const { role, selfId, room, ended } = input;
  const manage = !ended && canManageRoom(role, selfId, room);
  const menu = {
    code: !ended && room.code !== null,
    features: manage && isManager(role),
    access: manage && room.visibility === 'restricted',
    close: manage,
  };
  return { ...menu, empty: !Object.values(menu).some(Boolean) };
}

/** The join link of a quick room, on its server. */
export const joinLink = (origin: string, code: string): string =>
  `${origin.replace(/\/+$/, '')}/join/${code}`;

/** The chat retention choices of a room (days; 0 keeps nothing), as the web's. */
export const RETENTION_OPTIONS = [0, 7, 30, 90] as const satisfies readonly ChatRetentionDays[];

export interface ChatForm {
  retention: (typeof RETENTION_OPTIONS)[number];
  guestsCanWrite: boolean;
}

/** The chat settings a room stores, with the web's defaults (30 days, guests write). */
export function chatFormOf(settings: {
  chatRetentionDays?: number | undefined;
  guestsCanWrite?: boolean | undefined;
}): ChatForm {
  const days = RETENTION_OPTIONS.find((d) => d === settings.chatRetentionDays);
  return { retention: days ?? 30, guestsCanWrite: settings.guestsCanWrite !== false };
}

/** The template whose capabilities these are, or 'custom'. */
export function templateOf(capabilities: RoomCapabilities): Template {
  const id = (Object.keys(TEMPLATES) as TemplateId[]).find((t) =>
    sameCapabilities(TEMPLATES[t], capabilities),
  );
  return id ?? 'custom';
}

/**
 * The PATCH body of the features sheet (the web's RoomFeaturesDialog), or null when there is
 * nothing to save or the capabilities are not valid for the space. Chat settings only go along
 * when the room has text.
 */
export function featuresPatch(input: {
  stored: RoomCapabilities;
  value: RoomCapabilities;
  storedChat: ChatForm;
  chat: ChatForm;
  ceiling: RoomCapabilities;
}): {
  settings: {
    capabilities: RoomCapabilities;
    chatRetentionDays?: ChatRetentionDays;
    guestsCanWrite?: boolean;
  };
} | null {
  const { stored, value, storedChat, chat, ceiling } = input;
  if (!isValidCapabilities(value) || aboveCeiling(value, ceiling).length > 0) return null;
  const chatChanged =
    chat.retention !== storedChat.retention || chat.guestsCanWrite !== storedChat.guestsCanWrite;
  const sendChat = value.text && chatChanged;
  if (sameCapabilities(value, stored) && !sendChat) return null;
  return {
    settings: {
      capabilities: value,
      ...(sendChat
        ? { chatRetentionDays: chat.retention, guestsCanWrite: chat.guestsCanWrite }
        : {}),
    },
  };
}

/** Turning stream off ends the streams that are live now. */
export const endsStreams = (
  stored: RoomCapabilities,
  value: RoomCapabilities,
  liveStreams: number,
): boolean => stored.stream && !value.stream && liveStreams > 0;
