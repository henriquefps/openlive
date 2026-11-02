// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatMessage, Message, PayloadOf, RoomSettings, You } from '@openlive/protocol';
import { ChatClient, type ChatClientOptions, type ChatSocket } from '../src/chat/client.ts';

// A fake room socket for the chat client: records requests, delivers server messages.

export class FakeChatSocket implements ChatSocket {
  readonly sent: { id: string; type: string; payload: Record<string, unknown> }[] = [];
  open = true;
  private listener: ((message: Message) => void) | null = null;
  private nextId = 1;

  listen(listener: (message: Message) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  request(type: string, payload: object): string | null {
    if (!this.open) return null;
    const id = String(this.nextId++);
    this.sent.push({ id, type, payload: payload as Record<string, unknown> });
    return id;
  }

  /** The last request of a type. */
  last(type: string) {
    const found = this.sent.filter((s) => s.type === type).at(-1);
    if (!found) throw new Error(`no ${type} sent; sent: ${this.sent.map((s) => s.type).join()}`);
    return found;
  }

  receive<T extends Message['type']>(type: T, payload: PayloadOf<T>, id?: string): void {
    this.listener?.({ type, payload, ...(id === undefined ? {} : { id }) } as Message);
  }
}

export const SELF = 'u_ana';

export const you = (permissions: Partial<You['permissions']> = {}, role: You['role'] = 'member') =>
  ({
    userId: SELF,
    connectionId: 'c_1',
    role,
    permissions: {
      canStream: false,
      canModerate: role === 'owner' || role === 'admin',
      canReadChat: true,
      canWriteChat: true,
      ...permissions,
    },
  }) satisfies You;

export const chatSettings = (extra: Partial<RoomSettings> = {}): RoomSettings => ({
  maxStreams: 5,
  maxViewersPerStream: 6,
  maxBitrateKbps: 13_000,
  allowedPresets: ['text', 'game', 'max'],
  capabilities: { stream: true, voice: false, camera: false, text: true },
  chatRetentionDays: 30,
  guestsCanWrite: true,
  ...extra,
});

export function message(seq: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m_${seq}`,
    userId: 'u_bia',
    authorName: 'Bia',
    text: `message ${seq}`,
    createdAt: 1_767_225_600_000 + seq * 1_000,
    mentions: [],
    ...extra,
  };
}

/** A welcome as the room sends it to SELF. */
export function welcome(
  socket: FakeChatSocket,
  options: { you?: You; settings?: RoomSettings; chat?: PayloadOf<'welcome'>['chat'] } = {},
) {
  socket.receive('welcome', {
    protocol: { major: 1, minor: 20 },
    minProtocol: { major: 1, minor: 0 },
    serverTime: Date.now(),
    you: options.you ?? you(),
    room: { roomId: 'r_1', spaceId: 's_1', name: 'Room', kind: 'fixed', visibility: 'space' },
    settings: options.settings ?? chatSettings(),
    members: [
      { userId: SELF, displayName: 'Ana', role: 'member', canStream: false },
      { userId: 'u_bia', displayName: 'Bia', role: 'member', canStream: false },
    ],
    streams: [],
    ...(options.chat ? { chat: options.chat } : {}),
  });
}

/** A started client after the welcome and its first page. */
export function setupChat(
  page: ChatMessage[] = [],
  options: Parameters<typeof welcome>[1] & Partial<ChatClientOptions> = {},
) {
  const socket = new FakeChatSocket();
  let n = 0;
  const client = new ChatClient({
    socket,
    newClientId: () => `k${++n}`,
    now: () => 1_767_225_700_000,
    ...(options.onMention ? { onMention: options.onMention } : {}),
  });
  client.start();
  welcome(socket, options);
  const history = socket.sent.find((s) => s.type === 'chat.history');
  if (history)
    socket.receive('chat.page', { messages: page, hasMore: page.length >= 50 }, history.id);
  return { socket, client };
}
