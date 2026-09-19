// Talks to the Otto Tabs Chrome extension (extension/) about Study Mode's site-blocking feature. Mirrors
// the existing open-tab bridge's own pattern (a window.postMessage the content script relays to the
// background worker) — see extension/content.js. Best-effort throughout: if the extension isn't installed
// (no `data-weave-ext` flag on <html>), these are silent no-ops and Study Mode works exactly as before,
// just without site blocking — a browser extension can never be required to use the web app.

/** Is the Otto Tabs extension actually installed and active in this browser? */
export function hasExtension(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-weave-ext");
}

/** Start blocking other sites for the duration of this Study Mode session. Persisted extension-side
 *  (chrome.storage.local) so it survives a service-worker restart, a page reload, or even closing this tab
 *  — by design, only endStudyBlocking() (the deliberate long-press End action) turns it back off. */
export function startStudyBlocking(): void {
  if (!hasExtension()) return;
  try { window.postMessage({ type: "weave-study-mode-start" }, window.location.origin); } catch { /* best-effort */ }
}

/** Stop blocking — called ONLY from the deliberate long-press "End session" action (see EndSessionModal),
 *  never from a component unmount/navigation-away, so closing the tab or reloading mid-session does NOT
 *  bypass the block (that would defeat the entire point of the feature). */
export function stopStudyBlocking(): void {
  if (!hasExtension()) return;
  try { window.postMessage({ type: "weave-study-mode-end" }, window.location.origin); } catch { /* best-effort */ }
}
