// Network-first service worker. The old cache-first version served stale HTML after each
// deploy (pointing at hashed assets that no longer existed) → blank page. Now: always try
// the network; the cache is ONLY an offline fallback. API responses are never cached.
const CACHE_NAME = "otto-v3"; // bumped to flush any stale cached response from before the vercel.json routing fix

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
      .catch(() =>
        // Exact URL first (works for previously-visited static assets); for a navigation whose exact
        // path was never cached (e.g. a client-side route like /task/<id>), fall back to the cached
        // app shell "/" instead of resolving to undefined — respondWith() throws "Failed to convert
        // value to 'Response'" if the promise doesn't resolve to a real Response.
        caches.match(event.request, { ignoreSearch: url.pathname === "/" })
          .then((cached) => cached || (event.request.mode === "navigate" ? caches.match("/") : undefined))
          .then((res) => res || Response.error())
      )
  );
});
