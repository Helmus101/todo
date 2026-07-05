// Network-first service worker. The old cache-first version served stale HTML after each
// deploy (pointing at hashed assets that no longer existed) → blank page. Now: always try
// the network; the cache is ONLY an offline fallback. API responses are never cached.
const CACHE_NAME = "otto-v2";

self.addEventListener("install", (event) => {
  self.skipWaiting(); // replace the old (broken) worker immediately
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;
  // Never intercept API/auth traffic — stale task data is worse than a failed request.
  if (/^\/(api|auth|integrations)\//.test(url.pathname) || url.pathname === "/healthz") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: url.pathname === "/" }))
  );
});
