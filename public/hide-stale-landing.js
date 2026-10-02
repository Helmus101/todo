// Reported live: a RETURNING, already-logged-in visitor briefly saw the logged-out marketing Landing page
// before the real app took over. Root cause: dist/index.html's #root isn't empty — scripts/prerender-
// landing.tsx bakes static Landing markup into it at BUILD time (a first-paint/crawler fallback for a
// signed-out visitor, see that script's own comment), and the browser paints that static HTML immediately
// on every page load, logged in or not, for as long as it takes the real JS bundle to load/parse/mount and
// replace it — this app's own build flags a 900kb+ main chunk, so that window is genuinely visible, not a
// one-frame flicker.
//
// Fix: run a synchronous check as early as possible (parsed+executed during initial HTML parsing, long
// before the deferred module script even starts downloading) and clear the stale prerendered markup the
// instant there's cached evidence this visitor is actually logged in. The real app then mounts into the
// now-empty #root exactly as it would on any other load (its own loading spinner, then the dashboard) —
// this only removes the WRONG interim paint, it doesn't change what loads after.
//
// Kept in an external file, not inline, so the CSP can stay script-src 'self' (same reasoning as
// self-heal.js right below it) — loaded synchronously (no defer/async/module) so it runs in document
// order, before self-heal.js and before the main module script.
(function () {
  try {
    var raw = localStorage.getItem("weave-status");
    if (!raw) return; // no cached status at all (first-ever visit, or a cleared browser) — the static
                       // landing fallback is actually correct here, nothing to hide.
    var cached = JSON.parse(raw);
    if (cached && cached.loggedIn) {
      var root = document.getElementById("root");
      // Clear, don't replace with a fake spinner — a blank flash for a few ms until React mounts its own
      // loading state is a far smaller, more honest gap than duplicating that markup/CSS here and risking
      // it drifting from the real one.
      if (root) root.textContent = "";
    }
  } catch (e) { /* best-effort — a parse failure just leaves the prerendered landing visible, same as before this fix existed */ }
})();
