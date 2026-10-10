// Network-first service worker. The old cache-first version served stale HTML after each
// deploy (pointing at hashed assets that no longer existed) → blank page. Now: always try
// the network; the cache is ONLY an offline fallback. API responses are never cached.
const CACHE_NAME = "otto-v5"; // v5: page loads never resolve to a network-error response (offline page instead)

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

// Best-effort extra coverage for "proactive on a closed tab": Periodic Background Sync (Chrome/Android,
// installed PWA only — no iOS Safari support), and the browser decides real firing frequency from a site
// engagement score, so this is a bonus for engaged users on a supported browser, NOT a replacement for the
// server cron (server/jobs.ts's sweepDue) which is the only actually-guaranteed daily trigger on every
// platform. Registered from the client (see registerPeriodicSync in client/main.tsx) only where the
// browser supports it; this handler simply no-ops (never registered, never fires) everywhere else.
// Calls the SAME endpoint the open-tab sweep uses — the server's own once/day gate (lastGenTime,
// server/index.ts) makes an extra/early call here harmless, so no client-side dedup logic is needed here.
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "otto-sweep") {
    event.waitUntil(fetch("/api/tasks/generate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {}));
  }
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
          // A page load with nothing cached used to resolve to Response.error() — Chrome reports "The
          // FetchEvent … resulted in a network error response" and the student gets a dead tab (reported
          // live on /tutor/session/<id>). Retry the network once, then show a small page that reloads itself.
          .then((res) => res || (event.request.mode === "navigate"
            ? fetch(event.request).catch(() => offlinePage())
            : Response.error()))
      )
  );
});

function offlinePage() {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Otto</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;background:#faf8f5;color:#222;text-align:center}button{margin-top:12px;padding:8px 16px;border:0;border-radius:8px;background:#222;color:#fff;font:inherit;cursor:pointer}@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}button{background:#eee;color:#151515}}</style></head>
<body><div><p>Connexion perdue — nouvelle tentative…<br><small>Connection lost — retrying…</small></p><button onclick="location.reload()">Recharger / Reload</button></div>
<script>setTimeout(function(){location.reload()},5000)</script></body></html>`;
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
