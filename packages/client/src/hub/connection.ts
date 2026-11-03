// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ErrorPayload,
  HelperInfo,
  HelperStatsPayload,
  HelperStatusPayload,
  Message,
  NoticePayload,
  PayloadOf,
} from '@openlive/protocol';
import {
  CLOSE,
  OPEN,
  SocketSession,
  type SocketSessionOptions,
  without,
} from '../socket/session.ts';

// The client side of the user hub (docs/PROTOCOL.md 8): which of the user's helpers are online,
// their status and stats, and commands to them. Same handshake, keepalive and reconnect rules as
// the room socket (socket/session.ts). The hub rewrites ids between this tab and the helper, so
// replies come back under this tab's own ids.

/** Commands this tab sends to a helper through the hub (PROTOCOL.md 8.2). */
export type HubCommand =
  | 'helper.listSources'
  | 'helper.startStream'
  | 'helper.stopStream'
  | 'helper.pauseStream'
  | 'helper.setPreset'
  | 'helper.setVoiceOutput';

export type HubReply<T extends HubCommand> = T extends 'helper.listSources'
  ? PayloadOf<'helper.sources'>
  : PayloadOf<'ack'>;

/** A command's error reply, or a failure on this side (offline, timed out). */
export class HubError extends Error {
  constructor(readonly payload: ErrorPayload) {
    super(payload.code);
  }
}

/** A command the helper has not answered in this long fails (starting a stream takes seconds). */
export const COMMAND_TIMEOUT_MS = 30_000;

export type HubStatus = 'connecting' | 'open' | 'reconnecting' | 'ended';
/** Why the hub socket stopped for good (PROTOCOL 5). */
export type HubEnd = 'unauthenticated' | 'replaced' | 'reload';

export interface HubState {
  status: HubStatus;
  attempt: number;
  ended: HubEnd | null;
  /** The user's helpers that are online, by device id. */
  helpers: Record<string, HelperInfo>;
  /** The latest helper.status per device. */
  statuses: Record<string, HelperStatusPayload>;
  /** The latest helper.stats per device, while it streams. */
  stats: Record<string, HelperStatsPayload>;
  /**
   * Source picker thumbnails of the last listSources with thumbnails, as data: URLs, by
   * `deviceId/sourceId`. Kept in memory only.
   */
  thumbnails: Record<string, string>;
  /** The latest user notice (PROTOCOL.md 8.3), numbered so the same one twice is two. */
  notice: { seq: number; payload: NoticePayload } | null;
}

export const INITIAL_HUB_STATE: HubState = {
  status: 'connecting',
  attempt: 0,
  ended: null,
  helpers: {},
  statuses: {},
  stats: {},
  thumbnails: {},
  notice: null,
};

export const thumbnailKey = (deviceId: string, sourceId: string) => `${deviceId}/${sourceId}`;

export type HubConnectionOptions = SocketSessionOptions;

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (error: HubError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type VoiceShortcutListener = (shortcut: PayloadOf<'helper.voiceShortcut'>) => void;

export class HubConnection extends SocketSession<HubState> {
  private readonly pending = new Map<string, Pending>();
  private readonly shortcutListeners = new Set<VoiceShortcutListener>();

  constructor(options: HubConnectionOptions) {
    super(options, INITIAL_HUB_STATE);
  }

  start(): void {
    this.stopped = false;
    if (!this.active && !this.retrying) this.connect();
  }

  stop(): void {
    this.shutdown();
    this.failPending({ code: 'helper_offline' });
  }

  /** Connects again now: after "replaced", or to skip the backoff wait. */
  reconnect(): void {
    if (this.stopped) return;
    this.clearTimers();
    if (this.active) return;
    this.set({ ended: null });
    this.connect();
  }

  /**
   * Sends a command to one of the user's helpers and resolves with its reply. Rejects with a
   * HubError: the helper's error, helper_offline when the hub socket is down or drops, or
   * internal_error after COMMAND_TIMEOUT_MS.
   */
  request<T extends HubCommand>(type: T, payload: PayloadOf<T>): Promise<HubReply<T>> {
    const deviceId = (payload as { deviceId: string }).deviceId;
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || this.state.status !== 'open') {
      return Promise.reject(new HubError({ code: 'helper_offline', deviceId }));
    }
    if (type === 'helper.listSources') this.clearThumbnails(deviceId);
    const id = String(this.nextId++);
    return new Promise<HubReply<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HubError({ code: 'internal_error' }));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (p: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ type, id, payload }));
    });
  }

  /**
   * Global voice shortcuts of the user's helpers (PROTOCOL.md 8.5), every press and release in
   * order. Events, not state: a release must not be coalesced away.
   */
  onVoiceShortcut(listener: VoiceShortcutListener): () => void {
    this.shortcutListeners.add(listener);
    return () => this.shortcutListeners.delete(listener);
  }

  private clearThumbnails(deviceId: string): void {
    const prefix = `${deviceId}/`;
    this.set({
      thumbnails: Object.fromEntries(
        Object.entries(this.state.thumbnails).filter(([k]) => !k.startsWith(prefix)),
      ),
    });
  }

  private failPending(error: ErrorPayload): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new HubError(error));
    }
  }

  protected override connect(): void {
    this.set({ status: this.state.attempt === 0 ? 'connecting' : 'reconnecting' });
    super.connect();
  }

  protected onMessage(message: Message): void {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.type === 'error') pending.reject(new HubError(message.payload));
        else pending.resolve(message.payload);
        return;
      }
    }
    switch (message.type) {
      case 'hub.welcome': {
        this.welcomed();
        const helpers = Object.fromEntries(message.payload.helpers.map((h) => [h.deviceId, h]));
        // Statuses of helpers still online come right after the welcome.
        this.set({ status: 'open', attempt: 0, ended: null, helpers, statuses: {}, stats: {} });
        return;
      }
      case 'helper.online': {
        const { helper } = message.payload;
        this.set({ helpers: { ...this.state.helpers, [helper.deviceId]: helper } });
        return;
      }
      case 'helper.offline': {
        const { deviceId } = message.payload;
        this.clearThumbnails(deviceId);
        this.set({
          helpers: without(this.state.helpers, deviceId),
          statuses: without(this.state.statuses, deviceId),
          stats: without(this.state.stats, deviceId),
        });
        return;
      }
      case 'helper.status': {
        const status = message.payload;
        const live = status.state === 'live' || status.state === 'paused';
        this.set({
          statuses: { ...this.state.statuses, [status.deviceId]: status },
          ...(live ? {} : { stats: without(this.state.stats, status.deviceId) }),
        });
        return;
      }
      case 'helper.stats':
        this.set({ stats: { ...this.state.stats, [message.payload.deviceId]: message.payload } });
        return;
      case 'helper.sourceThumbnail': {
        const { deviceId, sourceId, mimeType, data } = message.payload;
        this.set({
          thumbnails: {
            ...this.state.thumbnails,
            [thumbnailKey(deviceId, sourceId)]: `data:${mimeType};base64,${data}`,
          },
        });
        return;
      }
      case 'helper.voiceShortcut':
        for (const listener of this.shortcutListeners) listener(message.payload);
        return;
      case 'notice':
        this.set({
          notice: { seq: (this.state.notice?.seq ?? 0) + 1, payload: message.payload },
        });
        return;
      default:
        // Errors without a pending request, and unknown types, are ignored (PROTOCOL 3).
        return;
    }
  }

  protected onLost(code: number): void {
    this.failPending({ code: 'helper_offline' });
    const ended: HubEnd | null =
      code === CLOSE.Unauthenticated
        ? 'unauthenticated'
        : code === CLOSE.Replaced
          ? 'replaced'
          : code === CLOSE.ProtocolUnsupported
            ? 'reload'
            : null;
    const offline = { helpers: {}, statuses: {}, stats: {}, thumbnails: {} };
    if (ended) {
      this.set({ status: 'ended', ended, ...offline });
      return;
    }
    const attempt = this.state.attempt;
    this.set({ status: 'reconnecting', attempt: attempt + 1, ...offline });
    this.retryLater(code, attempt);
  }
}
