import { useEffect, useState } from "react";

const KEY = "otto-canvas-mode";

/** Per-device "canvas mode" preference — same persisted-toggle pattern as useVoiceModePref.ts. When on,
 *  Ask Otto stops being open-ended task chat and becomes a focused, one-problem-at-a-time tutor: a single
 *  practice problem pinned at the top of the panel (the "canvas") instead of scrolling away in the
 *  thread, with the conversation below it acting as a running worked-steps log rather than free chat.
 *  Server-side, this also removes the note/flashcard/quiz tools entirely (see chatAboutTask's canvasMode
 *  branch in server/claude.ts) — Otto literally cannot reach for "make a whole quiz" while this is on.
 *  Off by default: same as voice mode, an opt-in mode, never auto-enabled. */
export function useCanvasModePref(): [boolean, () => void] {
  const [canvasModeOn, setCanvasModeOn] = useState(() => {
    try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(KEY, canvasModeOn ? "1" : "0"); } catch { /* best-effort */ }
  }, [canvasModeOn]);
  return [canvasModeOn, () => setCanvasModeOn((v) => !v)];
}
