// Real, student-presentable error messages for the Web Speech API's recognition error codes — the hook
// (useSpeechRecognition) used to swallow ALL of them silently: mic permission denied, no microphone
// plugged in, Chrome's speech backend unreachable — every failure mode looked identical to the student:
// a mic pill that lights up and hears nothing. These map the raw code to a bilingual [fr, en] pair the
// caller renders through L(). `no-speech` and `aborted` are deliberately absent: they're normal events
// in always-on mode (a silent gap; a deliberate stop), not errors, and surfacing them would just nag.

export type SpeechErrorCode =
  | "not-allowed" | "service-not-allowed" | "audio-capture" | "network"
  | "language-not-supported" | "language-not-supported-alt";

/** Raw code → [fr, en] message pair. `unknown` covers anything Chrome invents later. */
export function speechErrorMessage(code: string): [string, string] {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return [
        "Micro bloqué — autorise le micro pour ce site dans les réglages du navigateur, puis réessaie.",
        "Microphone blocked — allow mic access for this site in your browser settings, then try again.",
      ];
    case "audio-capture":
      return [
        "Aucun micro détecté — branche ou active un micro, puis réessaie.",
        "No microphone detected — connect or enable one, then try again.",
      ];
    case "network":
      return [
        "La reconnaissance vocale a besoin d'une connexion internet — réessaie.",
        "Speech recognition needs an internet connection — try again.",
      ];
    case "language-not-supported":
      return [
        "La reconnaissance vocale n'est pas disponible pour cette langue dans ce navigateur.",
        "Speech recognition isn't available for this language in this browser.",
      ];
    default:
      return [
        "Le micro n'a pas pu démarrer — réessaie.",
        "The microphone couldn't start — try again.",
      ];
  }
}
