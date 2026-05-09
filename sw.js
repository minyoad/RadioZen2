const CACHE_NAME = 'radiozen-v5';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // We try to cache both ./ and / to cover different serving strategies
      const urls = [...ASSETS_TO_CACHE];
      // Attempt to cache root if possible, but don't fail if it doesn't exist
      return cache.addAll(urls).catch(err => console.warn('SW cache addAll error:', err));
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ignore audio streams and non-http schemes
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.pathname.endsWith('.m3u8') || url.pathname.endsWith('.mp3') || url.pathname.endsWith('.aac')) {
    return;
  }

  // For Navigation (HTML): Network First, then Cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(event.request);
          if (networkResponse && networkResponse.status === 200) {
            return networkResponse;
          }
        } catch (error) {
           // Network failed, look in cache
        }
        
        const cache = await caches.open(CACHE_NAME);
        const cachedResponse = await cache.match(event.request);
        if (cachedResponse) return cachedResponse;

        // Fallback to index.html (SPA support)
        const indexResponse = await cache.match('./index.html');
        if (indexResponse) return indexResponse;

        return null;
      })()
    );
    return;
  }

  // Assets: Stale-While-Revalidate
  // SKIP CACHING FOR API CALLS
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {});

      return cachedResponse || fetchPromise;
    })
  );
});