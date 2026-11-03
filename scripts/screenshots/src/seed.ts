// SPDX-License-Identifier: AGPL-3.0-only
// Fictional data for the screenshots: users Ana (platform admin, owner of "Friends"), Bruno,
// Carla, Diego, Eva and Felipe, each with a profile photo uploaded through the API, the rooms "Movie night" (stream, voice, cameras, text), "Games" (stream),
// "Hangout" (voice with cameras) and "General" (text), a month of estimated usage and a published
// helper and Android app for the Download page. Users and usage have no API, so they go straight
// into the local D1, and the release manifests into the local bucket; everything else goes through
// the API as the DEV_AUTH user (X-Openlive-Dev-User, honoured only from localhost).

import { createHash } from 'node:crypto';
import { type Assets, avatarUpload } from './assets.ts';
import { API, type Stack } from './stack.ts';

export const USERS = {
  ana: { id: 'u_ana', name: 'Ana', email: 'ana@example.com', admin: true },
  bruno: { id: 'u_bruno', name: 'Bruno', email: 'bruno@example.com', admin: false },
  carla: { id: 'u_carla', name: 'Carla', email: 'carla@example.com', admin: false },
  diego: { id: 'u_diego', name: 'Diego', email: 'diego@example.com', admin: false },
  eva: { id: 'u_eva', name: 'Eva', email: 'eva@example.com', admin: false },
  felipe: { id: 'u_felipe', name: 'Felipe', email: 'felipe@example.com', admin: false },
} as const;

export type UserKey = keyof typeof USERS;

export async function api<T = Record<string, unknown>>(
  user: UserKey,
  method: string,
  path: string,
  body?: unknown,
  contentType = 'application/json',
): Promise<T> {
  const raw = body instanceof Blob;
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      'X-Openlive-Dev-User': USERS[user].id,
      Origin: API,
      ...(body === undefined ? {} : { 'Content-Type': contentType }),
    },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
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

export async function seed(stack: Stack, assets: Assets): Promise<Seeded> {
  const now = Date.now();
  const values = Object.values(USERS).map(
    (u, i) =>
      `('${u.id}', '${u.name}', '${u.email}', 'en', ${u.admin ? 1 : 0}, ${now - (40 - i * 6) * DAY_MS}, ${now - i * 3_600_000})`,
  );
  stack.d1(
    `INSERT INTO users (id, display_name, primary_email, locale, is_platform_admin, created_at, last_seen_at) VALUES ${values.join(', ')}`,
  );
  // Profile photos, as Settings -> Profile sends them (a 256 x 256 WebP).
  for (const user of Object.keys(USERS) as UserKey[]) {
    const photo = new Blob([new Uint8Array(await avatarUpload(assets.avatar[user]))]);
    await api(user, 'PUT', '/me/avatar', photo, 'image/webp');
  }

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
  for (const user of ['bruno', 'carla', 'diego', 'eva', 'felipe'] as const) {
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
  releases(stack, now);
  return { spaceId: space.id, rooms: { movies, games, hangout, general } };
}

/** A made-up but valid SHA-256 (of the file name), so the manifests parse. */
const fakeSha = (name: string) => createHash('sha256').update(name).digest('hex');

/**
 * The helper and the Android app as published from the public GitHub releases
 * (`helper:publish --from-release`), so the Download page shows its links.
 */
function releases(stack: Stack, now: number): void {
  const helper = '0.1.4';
  const android = '0.1.5';
  const asset = (tag: string, name: string) =>
    `https://github.com/henriquefps/openlive/releases/download/${tag}/${name}`;
  const at = new Date(now - 2 * DAY_MS).toISOString();
  const file = (name: string, kind: string, os: string, arch: string, size: number) => ({
    name,
    url: asset(`helper-v${helper}`, name),
    kind,
    os,
    arch,
    size,
    sha256: fakeSha(name),
  });
  stack.r2(
    'helper/latest.json',
    JSON.stringify({
      schema: 1,
      version: helper,
      publishedAt: at,
      protocol: { major: 1, minor: 21 },
      releaseNotesUrl: `https://github.com/henriquefps/openlive/releases/tag/helper-v${helper}`,
      files: [
        file(
          `openlive-helper-${helper}-linux-amd64.tar.gz`,
          'tarball',
          'linux',
          'amd64',
          14_221_312,
        ),
        file(`openlive-helper-${helper}.flatpak`, 'flatpak', 'linux', 'amd64', 31_457_280),
        file(`openlive-helper-${helper}-macos.dmg`, 'dmg', 'macos', 'universal', 22_544_384),
      ],
      signature: null,
    }),
  );
  const apk = `openlive-${android}-android.apk`;
  stack.r2(
    'helper/android.json',
    JSON.stringify({
      schema: 1,
      version: android,
      publishedAt: at,
      name: apk,
      url: asset(`android-v${android}`, apk),
      size: 48_234_496,
      sha256: fakeSha(apk),
    }),
  );
}

/** Turns the interactive tutorial off (or back on, from scratch) for a user. */
export function setTutorial(user: UserKey, on: boolean): Promise<unknown> {
  return api(user, 'PUT', '/me/tutorial', { seen: [], disabled: !on });
}
