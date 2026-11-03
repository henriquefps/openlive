// SPDX-License-Identifier: AGPL-3.0-only
import type { AppUser } from '@openlive/protocol';

// What the app remembers per instance. Everything goes to the platform's secure storage
// (expo-secure-store: the Android Keystore, the iOS Keychain): the list in one entry, each app
// token in its own, so signing out of one instance forgets exactly one secret.

/** The subset of expo-secure-store this module uses (an in-memory map in the tests). */
export interface SecureStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface SavedInstance {
  /** https://host[:port], the key of everything else. */
  origin: string;
  name: string;
  iconUrl?: string;
  /** The well-known's feature names when the instance was added or last checked. */
  features?: string[];
  /** Who the token signs in as, from the token exchange; absent when signed out. */
  user?: AppUser;
  tokenId?: string;
  addedAt: number;
}

const LIST_KEY = 'openlive.instances.v1';

/** Secure-store keys allow only [A-Za-z0-9._-]: the origin goes in as hex. */
export function tokenKey(origin: string): string {
  let hex = '';
  for (const byte of new TextEncoder().encode(origin)) hex += byte.toString(16).padStart(2, '0');
  return `openlive.token.${hex}`;
}

function isSaved(value: unknown): value is SavedInstance {
  const v = value as SavedInstance | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.origin === 'string' &&
    typeof v.name === 'string' &&
    typeof v.addedAt === 'number'
  );
}

export class InstanceStore {
  constructor(private readonly store: SecureStore) {}

  async list(): Promise<SavedInstance[]> {
    const raw = await this.store.getItemAsync(LIST_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isSaved) : [];
    } catch {
      return [];
    }
  }

  private async save(list: SavedInstance[]): Promise<void> {
    await this.store.setItemAsync(LIST_KEY, JSON.stringify(list));
  }

  /** Adds the instance, or updates the one with the same origin (keeping its place). */
  async upsert(instance: SavedInstance): Promise<SavedInstance[]> {
    const list = await this.list();
    const at = list.findIndex((i) => i.origin === instance.origin);
    if (at === -1) list.push(instance);
    else list[at] = instance;
    await this.save(list);
    return list;
  }

  /** Forgets the instance and its token. */
  async remove(origin: string): Promise<SavedInstance[]> {
    const list = (await this.list()).filter((i) => i.origin !== origin);
    await this.store.deleteItemAsync(tokenKey(origin));
    await this.save(list);
    return list;
  }

  getToken(origin: string): Promise<string | null> {
    return this.store.getItemAsync(tokenKey(origin));
  }

  /** Stores the token and who it signs in as. */
  async signIn(origin: string, token: string, user: AppUser, tokenId: string): Promise<void> {
    const list = await this.list();
    const at = list.findIndex((i) => i.origin === origin);
    const current = list[at];
    if (!current) throw new Error(`unknown instance ${origin}`);
    await this.store.setItemAsync(tokenKey(origin), token);
    list[at] = { ...current, user, tokenId };
    await this.save(list);
  }

  /** Forgets the token and the user; the instance stays in the list. */
  async signOut(origin: string): Promise<SavedInstance[]> {
    await this.store.deleteItemAsync(tokenKey(origin));
    const list = (await this.list()).map((i) => {
      if (i.origin !== origin) return i;
      const rest = { ...i };
      delete rest.user;
      delete rest.tokenId;
      return rest;
    });
    await this.save(list);
    return list;
  }
}
