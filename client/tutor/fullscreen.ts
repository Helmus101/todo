// Browser fullscreen for tutor mode. Must be called from a user gesture (clicking Start/Resume); anywhere it is
// unsupported (iPhone Safari) or refused it silently does nothing — the tutor still works.
export function inFullscreen(): boolean {
  return typeof document !== "undefined" && !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
}
export function enterFullscreen(): void {
  try {
    if (typeof document === "undefined" || inFullscreen()) return;
    const el = document.documentElement as any;
    const p = (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
    if (p && typeof p.catch === "function") p.catch(() => { /* refused — fine */ });
  } catch { /* unsupported */ }
}
export function exitFullscreen(): void {
  try {
    if (typeof document === "undefined" || !inFullscreen()) return;
    const d = document as any;
    const p = (d.exitFullscreen || d.webkitExitFullscreen)?.call(document);
    if (p && typeof p.catch === "function") p.catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}
