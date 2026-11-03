// SPDX-License-Identifier: AGPL-3.0-only
import { revokeAppToken } from '@openlive/client';
import type { AppUser, InstanceInfo } from '@openlive/protocol';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Linking, Platform } from 'react-native';
import { wipeServerCache } from './cache/client.ts';
import { type ApiClient, ApiError, appFetch, createAppClient, exchangeCode } from './lib/api.ts';
import { parseAppLink } from './lib/deeplink.ts';
import {
  APP_REDIRECT_URI,
  authorizeUrl,
  createPkce,
  deviceName,
  parseAuthRedirect,
  type PkceCrypto,
} from './lib/pkce.ts';
import { InstanceStore, type SavedInstance } from './lib/storage.ts';

// The instances on this phone and their tokens, for every screen. Each instance has its own
// token in secure storage; switching instances only changes which one a screen reads.

const pkceCrypto: PkceCrypto = {
  randomBytes: (length) => Crypto.getRandomBytes(length),
  sha256: async (data) =>
    new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(data))),
};

const store = new InstanceStore(SecureStore);

/** How a login ended; `error` carries the API's error code. */
export type LoginOutcome =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'denied' | 'state_mismatch' | 'invalid' }
  | { ok: false; reason: 'error'; code: string };

interface InstancesValue {
  ready: boolean;
  instances: SavedInstance[];
  add(origin: string, info: InstanceInfo): Promise<void>;
  signIn(origin: string, invite?: string): Promise<LoginOutcome>;
  signOut(origin: string): Promise<void>;
  /** The instance answered 401: the token is gone, keep the instance and ask to sign in. */
  expired(origin: string): Promise<void>;
  remove(origin: string): Promise<void>;
  /** Instances whose session ended (401, revoked) and have not signed in again since. */
  lost: ReadonlySet<string>;
  /** The name or photo changed: the saved instance shows the new ones. */
  updateUser(origin: string, user: AppUser): Promise<void>;
  /** A client with the instance's token, or null when signed out. */
  client(origin: string): Promise<ApiClient | null>;
}

const InstancesContext = createContext<InstancesValue | null>(null);

/** How long to wait for openlive://auth through Linking when the auth session did not return it. */
const LINK_GRACE_MS = 1500;

export function InstancesProvider({ children }: { children: ReactNode }) {
  const [instances, setInstances] = useState<SavedInstance[]>([]);
  const [ready, setReady] = useState(false);
  const [lost, setLost] = useState<ReadonlySet<string>>(new Set());
  // On Android the redirect can reach the app as a plain deep link instead of the auth
  // session's result; the login in progress takes it from here.
  const pendingAuth = useRef<((url: string) => void) | null>(null);

  useEffect(() => {
    void store.list().then((list) => {
      setInstances(list);
      setReady(true);
    });
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (parseAppLink(url).kind === 'auth') pendingAuth.current?.(url);
    });
    return () => subscription.remove();
  }, []);

  const add = useCallback(async (origin: string, info: InstanceInfo) => {
    const list = await store.list();
    const current = list.find((i) => i.origin === origin);
    const next: SavedInstance = {
      ...current,
      origin,
      name: info.name,
      features: info.features,
      addedAt: Date.now(),
    };
    if (current) next.addedAt = current.addedAt;
    if (info.iconUrl) next.iconUrl = info.iconUrl;
    else delete next.iconUrl;
    setInstances(await store.upsert(next));
  }, []);

  const signIn = useCallback(async (origin: string, invite?: string): Promise<LoginOutcome> => {
    const pkce = await createPkce(pkceCrypto);
    const device = deviceName(Device.modelName, Platform.OS === 'ios' ? 'iPhone' : 'Android');
    // Settles at once if the link already came in while the browser was open.
    const fromLink = new Promise<string>((resolve) => {
      pendingAuth.current = resolve;
    });
    let redirect: string | null;
    try {
      const result = await WebBrowser.openAuthSessionAsync(
        authorizeUrl(origin, pkce, device, invite),
        APP_REDIRECT_URI,
      );
      redirect =
        result.type === 'success'
          ? result.url
          : await Promise.race([
              fromLink,
              new Promise<null>((resolve) => setTimeout(() => resolve(null), LINK_GRACE_MS)),
            ]);
    } finally {
      pendingAuth.current = null;
    }
    if (!redirect) return { ok: false, reason: 'cancelled' };
    const parsed = parseAuthRedirect(redirect, pkce.state);
    if (!parsed.ok) return parsed;
    try {
      const answer = await exchangeCode(origin, parsed.code, pkce.verifier);
      await store.signIn(origin, answer.token, answer.user, answer.tokenId);
      // Whatever an earlier sign-in as somebody else left in the cache goes.
      await wipeServerCache(origin, answer.user.userId);
      setLost((set) => without(set, origin));
      setInstances(await store.list());
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: 'error',
        code: error instanceof ApiError ? error.body.code : 'internal_error',
      };
    }
  }, []);

  const signOut = useCallback(async (origin: string) => {
    const token = await store.getToken(origin);
    if (token) {
      // Revoke on the instance first; a token it no longer knows (401) or no network still
      // leaves the phone signed out.
      await revokeAppToken(createAppClient(origin, () => token)).catch(() => undefined);
    }
    setInstances(await store.signOut(origin));
    setLost((set) => without(set, origin));
    await wipeServerCache(origin);
  }, []);

  const expired = useCallback(async (origin: string) => {
    setLost((set) => new Set(set).add(origin));
    setInstances(await store.signOut(origin));
    await wipeServerCache(origin);
  }, []);

  const remove = useCallback(
    async (origin: string) => {
      await signOut(origin);
      setInstances(await store.remove(origin));
      await wipeServerCache(origin);
    },
    [signOut],
  );

  // A call that comes back 401 means the token is gone: forget it, keep the instance. Every screen
  // sees the instance as signed out and asks to sign in again.
  const expiredRef = useRef(expired);
  useEffect(() => {
    expiredRef.current = expired;
  }, [expired]);

  const updateUser = useCallback(async (origin: string, user: AppUser) => {
    const current = (await store.list()).find((i) => i.origin === origin);
    // A sign-out in the meantime wins; a different user is not this person's profile.
    if (!current?.user || current.user.userId !== user.userId) return;
    setInstances(await store.upsert({ ...current, user }));
  }, []);

  const client = useCallback(async (origin: string) => {
    const token = await store.getToken(origin);
    if (!token) return null;
    return createAppClient(
      origin,
      async () => (await store.getToken(origin)) ?? null,
      appFetch(() => void expiredRef.current(origin)),
    );
  }, []);

  const value = useMemo(
    () => ({ ready, instances, add, signIn, signOut, expired, remove, lost, updateUser, client }),
    [ready, instances, add, signIn, signOut, expired, remove, lost, updateUser, client],
  );
  return <InstancesContext.Provider value={value}>{children}</InstancesContext.Provider>;
}

function without(set: ReadonlySet<string>, origin: string): ReadonlySet<string> {
  const next = new Set(set);
  next.delete(origin);
  return next;
}

export function useInstances(): InstancesValue {
  const value = useContext(InstancesContext);
  if (!value) throw new Error('useInstances outside InstancesProvider');
  return value;
}
