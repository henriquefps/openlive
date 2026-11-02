// SPDX-License-Identifier: AGPL-3.0-only
import { PING_FRAME, type SocketLike } from '../src/room/connection.ts';

/** A WebSocket the test drives by hand. */
export class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: string[] = [];
  closedWith: number | undefined;

  constructor(readonly url: string) {}

  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  // --- test side ---
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  receive(type: string, payload: object, id?: string) {
    const frame = id === undefined ? { type, payload } : { type, id, payload };
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }
  /** Client messages after hello, parsed. */
  get requests() {
    return this.sent
      .slice(1)
      .filter((data) => data !== PING_FRAME)
      .map(
        (data) =>
          JSON.parse(data) as { type: string; id?: string; payload: Record<string, unknown> },
      );
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code }));
  }
  get hello() {
    return JSON.parse(this.sent[0] ?? 'null') as { type: string; payload: Record<string, unknown> };
  }
}
