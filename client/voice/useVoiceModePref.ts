import { useEffect, useState } from "react";

const KEY = "otto-voice-mode";

/** Per-device "voice mode" preference — one switch that means BOTH always-on listening and auto-speaking
 *  Otto's replies (these used to be two separate controls: a push-to-talk mic button, plus a speaker
 *  toggle — merged into one because managing them separately was confusing, and push-to-talk stopping
 *  after a single utterance felt broken for a "talk to Otto hands-free" experience). Shared by both chat
 *  surfaces (AskOttoPanel, TaskChat) so turning it on in one place doesn't need to be remembered separately
 *  in the other. Off by default: voice mode is opt-in, never auto-enabled.
 *
 *  PERSISTED BOTH WAYS. The first version only ever WROTE localStorage — `useState(false)` never read it
 *  back, so the value reset to OFF on every reload (and the mount effect immediately re-saved that reset
 *  over whatever was stored). Reported live as exactly what this file exists to prevent: the student turns
 *  voice on, Otto speaks — once — and after any reload the tutor is text-only again with zero speech, zero
 *  error, and (since speak() never fires) zero /api/tts calls. The lazy useState initializer reads the
 *  saved value once, guarded like every other localStorage touch here. */
const storedVoiceMode = (): boolean => {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
};

export function useVoiceModePref(): [boolean, () => void] {
  const [voiceModeOn, setVoiceModeOn] = useState(storedVoiceMode);
  useEffect(() => {
    try { localStorage.setItem(KEY, voiceModeOn ? "1" : "0"); } catch { /* best-effort */ }
  }, [voiceModeOn]);
  return [voiceModeOn, () => setVoiceModeOn((v) => !v)];
}
