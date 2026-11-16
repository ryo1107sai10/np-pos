importScripts('offline-assets.js');

const {revision,assets} = self.npPosStatic;
const scope = new URL(self.registration.scope);
const prefix = `np-pos-public:${scope.href}:`;
const cacheName = `${prefix}${revision}`;
const index = new URL('index.html', scope).href;
const publicUrls = new Map(assets.map(([name, integrity]) => [new URL(name, scope).href, integrity]));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    const requests = [...publicUrls].map(([url, integrity]) => new Request(url, {
      integrity, credentials: 'omit', redirect: 'error', cache: 'reload',
    }));
    try {
      // Keep the prior version active until all files of this version are available.
      for (let start = 0; start < requests.length; start += 12) {
        await cache.addAll(requests.slice(start, start + 12));
      }
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(prefix) && key !== cacheName).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('authorization') || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin) return;
  const home = request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === new URL(index).pathname);
  const key = home ? index : request.url;
  if (!publicUrls.has(key)) return;
  event.respondWith((async () => {
    const cached = await caches.match(key, {cacheName, ignoreVary: true});
    return cached ?? fetch(request);
  })());
});
