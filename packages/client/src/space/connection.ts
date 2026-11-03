// SPDX-License-Identifier: AGPL-3.0-only
import type { Message, RoomPresence } from '@openlive/protocol';
import { CLOSE, SocketSession, type SocketSessionOptions } from '../socket/session.ts';

// The client side of the space's room presence (docs/PROTOCOL.md 7.8): who is in each room's voice
// and who streams there, for the sidebar. One socket per shown space; same handshake, keepalive
// and reconnect rules as the room socket (socket/session.ts). The server only sends; this side
// only says hello.

export type SpacePresenceStatus = 'connecting' | 'open' | 'reconnecting' | 'ended';

export interface SpacePresenceState {
  status: SpacePresenceStatus;
  attempt: number;
  /** The non-empty summaries the user may see, by room id. */
  rooms: Record<string, RoomPresence>;
}

export const INITIAL_SPACE_PRESENCE: SpacePresenceState = {
  status: 'connecting',
  attempt: 0,
  rooms: {},
};

export type SpacePresenceOptions = SocketSessionOptions;

/** Closes after which the socket stays down (PROTOCOL 5): not signed in, no access, old app. */
const FINAL = new Set<number>([
  CLOSE.Unauthenticated,
  CLOSE.Replaced,
  CLOSE.Forbidden,
  CLOSE.ProtocolUnsupported,
]);

const quiet = (room: RoomPresence) => room.voice.length === 0 && room.live.length === 0;

export class SpacePresenceConnection extends SocketSession<SpacePresenceState> {
  constructor(options: SpacePresenceOptions) {
    super(options, INITIAL_SPACE_PRESENCE);
  }

  start(): void {
    this.stopped = false;
    if (!this.active && !this.retrying) this.connect();
  }

  stop(): void {
    this.shutdown();
  }

  /** Connects again now, skipping the backoff wait (the browser came back online). */
  reconnect(): void {
    if (this.stopped || this.state.status !== 'reconnecting') return;
    this.clearTimers();
    if (this.active) return;
    this.connect();
  }

  /** This socket's only request is the hello. */
  protected override helloId(): string {
    return '1';
  }

  protected override connect(): void {
    this.set({ status: this.state.attempt === 0 ? 'connecting' : 'reconnecting' });
    super.connect();
  }

  protected onMessage(message: Message): void {
    switch (message.type) {
      case 'space.presence': {
        // The welcome, or a fresh list after the user's access changed: it replaces everything.
        this.welcomed();
        const rooms = Object.fromEntries(
          message.payload.rooms.filter((r) => !quiet(r)).map((r) => [r.roomId, r]),
        );
        this.set({ status: 'open', attempt: 0, rooms });
        return;
      }
      case 'space.presence.updated': {
        const { room } = message.payload;
        const rest = Object.fromEntries(
          Object.entries(this.state.rooms).filter(([id]) => id !== room.roomId),
        );
        this.set({ rooms: quiet(room) ? rest : { ...rest, [room.roomId]: room } });
        return;
      }
      default:
        // Errors (followed by a close) and unknown types are ignored (PROTOCOL 3).
        return;
    }
  }

  protected onLost(code: number): void {
    if (FINAL.has(code)) {
      this.set({ status: 'ended', rooms: {} });
      return;
    }
    // The last known presence stays on screen while reconnecting; the welcome replaces it.
    const attempt = this.state.attempt;
    this.set({ status: 'reconnecting', attempt: attempt + 1 });
    this.retryLater(code, attempt);
  }
}
