import { useEffect, useState } from "react";

const KEY = "otto-voice-mode";

/** Per-device "voice mode" preference — one switch that means BOTH always-on listening and auto-speaking
 *  Otto's replies (these used to be two separate controls: a push-to-talk mic button, plus a speaker
 *  toggle — merged into one because managing them separately was confusing, and push-to-talk stopping
 *  after a single utterance felt broken for a "talk to Otto hands-free" experience). Shared by both chat
 *  surfaces (AskOttoPanel, TaskChat) so turning it on in one place doesn't need to be remembered separately
 *  in the other. Off by default: voice mode is opt-in, never auto-enabled. */
export function useVoiceModePref(): [boolean, () => void] {
  const [voiceModeOn, setVoiceModeOn] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(KEY, voiceModeOn ? "1" : "0"); } catch { /* best-effort */ }
  }, [voiceModeOn]);
  return [voiceModeOn, () => setVoiceModeOn((v) => !v)];
}
