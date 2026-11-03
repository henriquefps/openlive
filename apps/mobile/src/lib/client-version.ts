// SPDX-License-Identifier: AGPL-3.0-only

/**
 * hello.clientVersion of the app's sockets. The protocol wants semver (`0.1.0`, build metadata
 * allowed), so the app is `0.1.0+mobile`; a non-semver value is an invalid hello and the room
 * never welcomes the socket.
 */
export function helloClientVersion(appVersion: string | undefined): string {
  const version = appVersion && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(appVersion) ? appVersion : '0.0.0';
  return `${version}+mobile`;
}
