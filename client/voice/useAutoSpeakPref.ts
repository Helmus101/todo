import { useEffect, useState } from "react";

const KEY = "otto-voice-autospeak";

/** Per-device "speak Otto's replies aloud" preference — shared by both chat surfaces (AskOttoPanel,
 *  TaskChat) so turning it on in one place doesn't need to be remembered separately in the other. Off by
 *  default: voice output is opt-in, never auto-enabled just because voice INPUT (the mic) was used once. */
export function useAutoSpeakPref(): [boolean, () => void] {
  const [autoSpeak, setAutoSpeak] = useState(() => {
    try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(KEY, autoSpeak ? "1" : "0"); } catch { /* best-effort */ }
  }, [autoSpeak]);
  return [autoSpeak, () => setAutoSpeak((v) => !v)];
}
