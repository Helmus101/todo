import { useState } from "react";

/** Per-session "voice mode" switch — one control that means BOTH always-on listening and auto-speaking
 *  Otto's replies (these used to be two separate controls: a push-to-talk mic button, plus a speaker
 *  toggle — merged into one because managing them separately was confusing, and push-to-talk stopping
 *  after a single utterance felt broken for a "talk to Otto hands-free" experience). Shared by all chat
 *  surfaces (AskOttoPanel, TaskChat, StudyHelpPanel) so the switch behaves identically everywhere.
 *
 *  ALWAYS STARTS OFF — product rule: the microphone is NEVER on by default. Every page load begins with
 *  voice mode off, and only an explicit tap on the mic button turns it on, for that session only. This
 *  used to persist in localStorage ("otto-voice-mode"), which meant any reload silently re-opened the
 *  microphone with no fresh consent from the student — reported live as "the mic should never by default
 *  be on; it is first always off". (The pre-consent auto-enable path, startInVoiceMode, was removed from
 *  AskOttoPanel for the same reason: no code path may turn the mic on without a user tap.) */
export function useVoiceModePref(): [boolean, () => void] {
  const [voiceModeOn, setVoiceModeOn] = useState(false);
  return [voiceModeOn, () => setVoiceModeOn((v) => !v)];
}
