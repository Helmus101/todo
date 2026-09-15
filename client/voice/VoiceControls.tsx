import { Mic, MicOff, Volume2 } from "lucide-react";

// Presentational only — deliberately dumb. One switch: "voice mode" on/off. ON means always-listening
// (no push-to-talk tap needed per turn) AND auto-speaking Otto's replies — the two used to be separate
// controls (a mic-tap button + a speaker toggle), which was confusing and, worse, meant tapping the mic
// ended the session after one utterance instead of staying on. State (the two Web Speech hooks, the
// voiceMode preference, the send/speak wiring) lives in each call site (AskOttoPanel.tsx, TaskCard.tsx's
// TaskChat) since they already own their own chat state; this just renders the shared UI so the two
// surfaces don't drift into slightly different voice experiences.
// Real lucide icons instead of emoji — a 🎙/🔊 emoji renders differently (or not at all) across OS/browser
// combinations and reads ambiguous at a glance; a crossed-out mic vs. a plain mic vs. a speaker icon is
// unambiguous regardless of platform, matching every other icon in the app (BookOpen, etc. already use
// lucide-react).
interface VoiceControlsProps {
  supported: boolean;
  voiceModeOn: boolean;
  listening: boolean;
  speaking: boolean;
  interimTranscript: string;
  onToggle: () => void;
  en: boolean;
}

export function VoiceControls({ supported, voiceModeOn, listening, speaking, interimTranscript, onToggle, en }: VoiceControlsProps) {
  if (!supported) return null; // no SpeechRecognition on this browser (e.g. Firefox) — hide, don't show a dead button
  const state = speaking ? "speaking" : listening ? "listening" : voiceModeOn ? "idle-on" : "off";
  const title = !voiceModeOn
    ? (en ? "Turn on voice mode — talk to Otto hands-free" : "Activer le mode vocal — parle à Otto en mains libres")
    : speaking
    ? (en ? "Otto is speaking — tap to turn off voice mode" : "Otto parle — touche pour désactiver le mode vocal")
    : listening
    ? (en ? "Listening — tap to turn off voice mode" : "Écoute en cours — touche pour désactiver le mode vocal")
    : (en ? "Voice mode on — tap to turn off" : "Mode vocal activé — touche pour désactiver");
  return (
    <div className="voice-controls">
      {voiceModeOn && listening && interimTranscript ? <span className="voice-interim">{interimTranscript}</span> : null}
      <button
        type="button"
        className={`voice-mic-btn voice-mic-${state}`}
        onClick={onToggle}
        title={title}
        aria-label={title}
        aria-pressed={voiceModeOn}
      >
        {speaking ? <Volume2 size={16} /> : voiceModeOn ? <Mic size={16} /> : <MicOff size={16} />}
      </button>
    </div>
  );
}
