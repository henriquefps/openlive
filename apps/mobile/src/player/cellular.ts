// SPDX-License-Identifier: AGPL-3.0-only
import { isCellularConnection } from '@openlive/client';

// Whether the phone is on a cellular connection (the web reads navigator.connection.type): the
// player starts Automatic on the middle layer there. expo-network is passed in so the tests can
// drive it; the controller asks `cellular` on every playback step, so a change of network counts
// as soon as Automatic starts again.

export interface NetworkLike {
  getNetworkStateAsync(): Promise<{ type?: string }>;
  addNetworkStateListener(listener: (state: { type?: string }) => void): { remove(): void };
}

export class CellularMonitor {
  private on = false;
  private off: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly network: NetworkLike) {}

  /** The last known kind; false until the first read answers. */
  get cellular(): boolean {
    return this.on;
  }

  start(): void {
    this.stopped = false;
    const subscription = this.network.addNetworkStateListener((state) => {
      this.on = isCellularConnection(state.type);
    });
    this.off = () => subscription.remove();
    void this.network
      .getNetworkStateAsync()
      .then((state) => {
        if (!this.stopped) this.on = isCellularConnection(state.type);
      })
      .catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.off?.();
    this.off = null;
  }
}
