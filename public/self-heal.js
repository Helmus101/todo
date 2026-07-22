// Self-heal after a deploy: if the app's JS module fails to load (stale HTML / service-worker pointing at
// an old hashed bundle), nuke SW caches and hard-reload ONCE instead of showing a blank page.
// Kept in an external file (not inline) so the Content-Security-Policy can stay script-src 'self'.
window.addEventListener("error", function (e) {
  var t = e.target;
  if (!(t && t.tagName === "SCRIPT" && t.type === "module")) return;
  if (sessionStorage.getItem("otto-recovered")) return;
  sessionStorage.setItem("otto-recovered", "1");
  var wipe = window.caches ? caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }) : Promise.resolve();
  wipe.then(function () {
    if (navigator.serviceWorker) return navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); });
  }).then(function () { location.reload(); });
}, true);
