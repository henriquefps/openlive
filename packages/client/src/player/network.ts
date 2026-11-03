// SPDX-License-Identifier: AGPL-3.0-only

// The connection kinds the player cares about, named by whoever reads them: the browser's
// `navigator.connection.type` ('cellular') and expo-network's `NetworkStateType` ('CELLULAR').

/** A cellular connection, where Automatic starts on the middle layer. */
export function isCellularConnection(type: string | null | undefined): boolean {
  return type?.toLowerCase() === 'cellular';
}
