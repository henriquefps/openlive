// SPDX-License-Identifier: AGPL-3.0-only
import type { HelperInfo, HubWelcomePayload } from '@openlive/protocol';
import { HubConnection } from '../src/hub/connection.ts';
import { FakeSocket } from './fake-socket.ts';

export const PC: HelperInfo = {
  deviceId: 'd_pc',
  name: "Ana's PC",
  os: 'linux',
  arch: 'amd64',
  helperVersion: '0.1.0',
  protocol: { major: 1, minor: 20 },
};

export function hubWelcome(helpers: HelperInfo[] = [PC]): HubWelcomePayload {
  return {
    protocol: { major: 1, minor: 20 },
    minProtocol: { major: 1, minor: 0 },
    serverTime: Date.now(),
    userId: 'u_ana',
    connectionId: 'c_1',
    helpers,
  };
}

/** A hub connection on a fake socket, welcomed with `helpers`. */
export function connectedHub(helpers: HelperInfo[] = [PC]): {
  hub: HubConnection;
  socket: FakeSocket;
} {
  let socket: FakeSocket | null = null;
  const hub = new HubConnection({
    url: 'ws://localhost/ws/hub',
    tabId: 't_tab',
    createSocket: (url) => (socket = new FakeSocket(url)),
  });
  hub.start();
  if (!socket) throw new Error('no socket');
  const s: FakeSocket = socket;
  s.open();
  s.receive('hub.welcome', hubWelcome(helpers), '1');
  return { hub, socket: s };
}
