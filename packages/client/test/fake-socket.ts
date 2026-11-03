// SPDX-License-Identifier: AGPL-3.0-only
import type { SocketLike } from '../src/index.ts';

/** A WebSocket the test drives by hand, with no DOM events (as in React Native or Node). */
export class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
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
    this.onopen?.({});
  }
  receive(type: string, payload: object, id?: string) {
    const frame = id === undefined ? { type, payload } : { type, id, payload };
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get hello() {
    return JSON.parse(this.sent[0] ?? 'null') as {
      type: string;
      id: string;
      payload: Record<string, unknown>;
    };
  }
}
