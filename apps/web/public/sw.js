// SPDX-License-Identifier: AGPL-3.0-only
// Openlive service worker: caches the app shell only, so the installed app opens fast and shows
// its own offline state. Never the API, the sockets or media: those always go
// to the network. Plain JS served as is from public/.
const CACHE = 'openlive-shell-v1';
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.ico',
];
/** Hashed build files kept at most; older ones are dropped first. */
const MAX_ASSETS = 150;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

function bypass(request, url) {
  if (request.method !== 'GET' || url.origin !== self.location.origin) return true;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return true;
  if (request.headers.has('range')) return true;
  return request.destination === 'video' || request.destination === 'audio';
}

async function trim(cache) {
  const keys = (await cache.keys()).filter((r) => new URL(r.url).pathname.startsWith('/assets/'));
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (bypass(request, url)) return;

  // Pages: the network first (a deploy shows at once), the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put('/', copy));
          }
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Hashed build files never change: the cache first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(CACHE).then(async (cache) => {
                await cache.put(request, copy);
                await trim(cache);
              });
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Icons and the manifest: the cache, refreshed in the background.
  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const fresh = fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        });
        return cached ?? fresh;
      }),
    );
  }
});
