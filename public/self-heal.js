// Self-heal after a deploy: if the app's JS module OR its stylesheet fails to load (stale HTML / a
// service-worker pointing at an old hashed bundle whose file no longer exists after a new deploy), nuke SW
// caches and hard-reload ONCE instead of showing a blank/unstyled page.
// Kept in an external file (not inline) so the Content-Security-Policy can stay script-src 'self'.
window.addEventListener("error", function (e) {
  var t = e.target;
  // A stylesheet 404 previously fell through here silently (only SCRIPT was checked) — the page still
  // worked (the JS bundle loaded fine), it just rendered with zero CSS, which reads as "the app broke,
  // there's no CSS now" rather than the familiar blank-page failure this handler already caught.
  var isStaleScript = t && t.tagName === "SCRIPT" && t.type === "module";
  var isStaleStylesheet = t && t.tagName === "LINK" && t.rel === "stylesheet";
  if (!isStaleScript && !isStaleStylesheet) return;
  if (sessionStorage.getItem("otto-recovered")) return;
  sessionStorage.setItem("otto-recovered", "1");
  var wipe = window.caches ? caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }) : Promise.resolve();
  wipe.then(function () {
    if (navigator.serviceWorker) return navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); });
  }).then(function () { location.reload(); });
}, true);
