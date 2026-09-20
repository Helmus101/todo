import { useEffect, useState } from "react";

const KEY_PREFIX = "otto-seen-";

/** Has this feature been shown to this student before, on this device? Backs FirstTimeHint (see its own
 *  comment for why this exists) but exposed separately for any component that wants first-time behavior
 *  without the visual coachmark — e.g. auto-opening a panel the first time, not just annotating it.
 *  `id` should be a short, stable, unique key ("study-canvas", "board", "flashcard-review") — changing it
 *  later re-shows the hint to everyone, which is occasionally useful (a reworked feature) but not something
 *  to do by accident. */
export function useFirstTime(id: string): [boolean, () => void] {
  const key = KEY_PREFIX + id;
  const [isFirst, setIsFirst] = useState(() => {
    try { return localStorage.getItem(key) !== "1"; } catch { return false; } // best-effort: private/blocked storage just means no coachmarks, never a crash
  });
  const dismiss = () => {
    setIsFirst(false);
    try { localStorage.setItem(key, "1"); } catch { /* best-effort */ }
  };
  return [isFirst, dismiss];
}
