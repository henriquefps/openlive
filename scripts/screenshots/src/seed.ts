// SPDX-License-Identifier: AGPL-3.0-only
// Fictional data for the screenshots: users Ana (platform admin, owner of "Friends"), Bruno,
// Carla and Diego, the rooms "Movie night" (stream, voice, cameras, text), "Games" (stream),
// "Hangout" (voice with cameras) and "General" (text), and a month of estimated usage. Users and usage
// have no API, so they go straight into the local D1; everything else goes through the API as
// the DEV_AUTH user (X-Openlive-Dev-User, honoured only from localhost).

import { API, type Stack } from './stack.ts';

export const USERS = {
  ana: { id: 'u_ana', name: 'Ana', email: 'ana@example.com', admin: true },
  bruno: { id: 'u_bruno', name: 'Bruno', email: 'bruno@example.com', admin: false },
  carla: { id: 'u_carla', name: 'Carla', email: 'carla@example.com', admin: false },
  diego: { id: 'u_diego', name: 'Diego', email: 'diego@example.com', admin: false },
} as const;

export type UserKey = keyof typeof USERS;

export async function api<T = Record<string, unknown>>(
  user: UserKey,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      'X-Openlive-Dev-User': USERS[user].id,
      Origin: API,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export interface Seeded {
  spaceId: string;
  rooms: { movies: string; games: string; hangout: string; general: string };
}

const caps = (stream: boolean, voice: boolean, camera: boolean, text: boolean) => ({
  settings: { capabilities: { stream, voice, camera, text } },
});

const DAY_MS = 86_400_000;

export async function seed(stack: Stack): Promise<Seeded> {
  const now = Date.now();
  const values = Object.values(USERS).map(
    (u, i) =>
      `('${u.id}', '${u.name}', '${u.email}', 'en', ${u.admin ? 1 : 0}, ${now - (40 - i * 6) * DAY_MS}, ${now - i * 3_600_000})`,
  );
  stack.d1(
    `INSERT INTO users (id, display_name, primary_email, locale, is_platform_admin, created_at, last_seen_at) VALUES ${values.join(', ')}`,
  );

  const { space } = await api<{ space: { id: string } }>('ana', 'POST', '/spaces', {
    name: 'Friends',
    slug: 'friends',
  });
  const room = async (name: string, slug: string, settings: ReturnType<typeof caps>) =>
    (
      await api<{ room: { id: string } }>('ana', 'POST', `/spaces/${space.id}/rooms`, {
        name,
        slug,
        ...settings,
      })
    ).room.id;
  const movies = await room('Movie night', 'movie-night', caps(true, true, true, true));
  const games = await room('Games', 'games', caps(true, false, false, false));
  const hangout = await room('Hangout', 'hangout', caps(false, true, true, false));
  const general = await room('General', 'general', caps(false, false, false, true));
  for (const user of ['bruno', 'carla', 'diego'] as const) {
    const { token } = await api<{ token: string }>('ana', 'POST', `/spaces/${space.id}/invites`, {
      role: 'member',
    });
    await api(user, 'POST', `/invites/${token}/accept`, {});
  }
  // A second, smaller space, so the admin overview lists more than one.
  const { space: club } = await api<{ space: { id: string } }>('ana', 'POST', '/spaces', {
    name: 'Book club',
    slug: 'book-club',
  });
  const { token } = await api<{ token: string }>('ana', 'POST', `/spaces/${club.id}/invites`, {
    role: 'member',
  });
  await api('diego', 'POST', `/invites/${token}/accept`, {});

  // A month of estimated egress so far: the admin overview's meter, projection and per-space rows.
  const usage: string[] = [];
  for (let d = 1; d <= 26; d++) {
    const day = new Date(now - d * DAY_MS).toISOString().slice(0, 10);
    const wave = 1 + Math.sin(d * 1.7) * 0.5;
    usage.push(
      `('${space.id}', '${day}', ${(5.2 * wave).toFixed(2)}, ${Math.round(310 * wave)}, ${Math.round(95 * wave)})`,
      `('${club.id}', '${day}', ${(0.9 * wave).toFixed(2)}, ${Math.round(48 * wave)}, ${Math.round(22 * wave)})`,
    );
  }
  stack.d1(
    `INSERT INTO usage_daily (space_id, day, egress_gb_est, viewer_minutes, stream_minutes) VALUES ${usage.join(', ')}`,
  );
  return { spaceId: space.id, rooms: { movies, games, hangout, general } };
}

/** Turns the interactive tutorial off (or back on, from scratch) for a user. */
export function setTutorial(user: UserKey, on: boolean): Promise<unknown> {
  return api(user, 'PUT', '/me/tutorial', { seen: [], disabled: !on });
}
