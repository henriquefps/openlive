// SPDX-License-Identifier: AGPL-3.0-only

// The app's screens as a stack of routes: the instance list at the bottom, an instance above it,
// then its space, then a room. Pure, so the rules (what back does, what a lost session does) are
// tested without a device.

export type Route =
  | { name: 'home' }
  | { name: 'add'; origin?: string; invite?: string }
  | { name: 'scan' }
  | { name: 'voice-debug' }
  | { name: 'instance'; origin: string; invite?: string; expired?: true }
  | { name: 'space'; origin: string; spaceId: string; spaceName: string }
  | { name: 'room'; origin: string; spaceId: string; roomId: string; roomName: string };

export type Stack = readonly Route[];

export const HOME: Route = { name: 'home' };
export const INITIAL_STACK: Stack = [HOME];

export function instanceRoute(origin: string, invite?: string): Route {
  return invite ? { name: 'instance', origin, invite } : { name: 'instance', origin };
}

export function addRoute(origin: string, invite?: string): Route {
  return invite ? { name: 'add', origin, invite } : { name: 'add', origin };
}

export function spaceRoute(origin: string, spaceId: string, spaceName: string): Route {
  return { name: 'space', origin, spaceId, spaceName };
}

export function roomRoute(
  origin: string,
  spaceId: string,
  roomId: string,
  roomName: string,
): Route {
  return { name: 'room', origin, spaceId, roomId, roomName };
}

export const top = (stack: Stack): Route => stack[stack.length - 1] ?? HOME;

export const push = (stack: Stack, route: Route): Stack => [...stack, route];

/** Back: one screen down; the bottom one stays. */
export const pop = (stack: Stack): Stack => (stack.length > 1 ? stack.slice(0, -1) : stack);

/** The home screen with `route` above it (a deep link, an instance picked from the list). */
export const reset = (route: Route): Stack => [HOME, route];

/** The origin a route belongs to, when it belongs to one. */
export function originOf(route: Route): string | undefined {
  return route.name === 'home' || route.name === 'scan' || route.name === 'voice-debug'
    ? undefined
    : route.origin;
}

/**
 * The session on `origin` ended (a 401, a sign-out): the spaces and rooms of that instance
 * cannot stay open, so the stack goes back to its instance screen, which asks to sign in again.
 * A stack with none of its screens open is returned as it is.
 */
export function sessionLost(stack: Stack, origin: string): Stack {
  const at = stack.findIndex(
    (r) => (r.name === 'space' || r.name === 'room') && r.origin === origin,
  );
  if (at === -1) return stack;
  const kept = stack.slice(0, at);
  const last = kept[kept.length - 1];
  const lost: Route = { name: 'instance', origin, expired: true };
  return last?.name === 'instance' && last.origin === origin
    ? [...kept.slice(0, -1), lost]
    : [...kept, lost];
}

/** The instance was removed from the phone: everything that belonged to it goes. */
export function instanceRemoved(stack: Stack, origin: string): Stack {
  const kept = stack.filter((r) => originOf(r) !== origin);
  return kept.length > 0 ? kept : INITIAL_STACK;
}
