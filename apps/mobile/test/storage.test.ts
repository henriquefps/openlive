// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { InstanceStore, type SecureStore, tokenKey } from '../src/lib/storage.ts';

function memoryStore(): SecureStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItemAsync: async (key) => {
      expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
      return data.get(key) ?? null;
    },
    setItemAsync: async (key, value) => {
      expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
      data.set(key, value);
    },
    deleteItemAsync: async (key) => {
      data.delete(key);
    },
  };
}

const A = 'https://a.example.com';
const B = 'https://b.example.org:8443';
const user = (n: string) => ({ userId: `u-${n}`, displayName: n });

describe('tokenKey', () => {
  it('is a valid secure-store key, different per origin', () => {
    expect(tokenKey(A)).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(tokenKey(A)).not.toBe(tokenKey(B));
    expect(tokenKey(A)).toBe(tokenKey(A));
  });
});

describe('InstanceStore', () => {
  it('keeps one token per instance', async () => {
    const secure = memoryStore();
    const store = new InstanceStore(secure);
    await store.upsert({ origin: A, name: 'a', addedAt: 1 });
    await store.upsert({ origin: B, name: 'b', addedAt: 2 });
    await store.signIn(A, 'ola_tokenA', user('Ana'), 't-a');
    await store.signIn(B, 'ola_tokenB', user('Bia'), 't-b');

    expect(await store.getToken(A)).toBe('ola_tokenA');
    expect(await store.getToken(B)).toBe('ola_tokenB');
    const list = await store.list();
    expect(list.map((i) => [i.origin, i.user?.displayName])).toEqual([
      [A, 'Ana'],
      [B, 'Bia'],
    ]);
    // Tokens never go into the list entry.
    expect(secure.data.get('openlive.instances.v1')).not.toContain('ola_');
  });

  it('signs out of one instance only, keeping it on the list', async () => {
    const store = new InstanceStore(memoryStore());
    await store.upsert({ origin: A, name: 'a', addedAt: 1 });
    await store.upsert({ origin: B, name: 'b', addedAt: 2 });
    await store.signIn(A, 'ola_tokenA', user('Ana'), 't-a');
    await store.signIn(B, 'ola_tokenB', user('Bia'), 't-b');

    const list = await store.signOut(A);
    expect(await store.getToken(A)).toBeNull();
    expect(await store.getToken(B)).toBe('ola_tokenB');
    expect(list.find((i) => i.origin === A)).toEqual({ origin: A, name: 'a', addedAt: 1 });
    expect(list.find((i) => i.origin === B)?.user).toEqual(user('Bia'));
  });

  it('removes an instance and its token', async () => {
    const secure = memoryStore();
    const store = new InstanceStore(secure);
    await store.upsert({ origin: A, name: 'a', addedAt: 1 });
    await store.signIn(A, 'ola_tokenA', user('Ana'), 't-a');
    expect(await store.remove(A)).toEqual([]);
    expect(await store.getToken(A)).toBeNull();
    expect([...secure.data.keys()]).toEqual(['openlive.instances.v1']);
  });

  it('updates an instance in place', async () => {
    const store = new InstanceStore(memoryStore());
    await store.upsert({ origin: A, name: 'a', addedAt: 1 });
    await store.upsert({ origin: B, name: 'b', addedAt: 2 });
    await store.upsert({ origin: A, name: 'renamed', addedAt: 1 });
    expect((await store.list()).map((i) => i.name)).toEqual(['renamed', 'b']);
  });

  it('refuses a token for an instance that is not on the list', async () => {
    const store = new InstanceStore(memoryStore());
    await expect(store.signIn(A, 'ola_x', user('Ana'), 't')).rejects.toThrow();
  });

  it('survives a corrupt list', async () => {
    const secure = memoryStore();
    secure.data.set('openlive.instances.v1', '{not json');
    expect(await new InstanceStore(secure).list()).toEqual([]);
    secure.data.set('openlive.instances.v1', JSON.stringify([{ origin: A }, 3]));
    expect(await new InstanceStore(secure).list()).toEqual([]);
  });
});
