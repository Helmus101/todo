// Presentational only — deliberately dumb. State (the two Web Speech hooks, the autoSpeak preference, the
// send/speak wiring) lives in each call site (AskOttoPanel.tsx, TaskCard.tsx's TaskChat) since they already
// own their own chat state; this just renders the mic button + "speak replies aloud" toggle both surfaces
// share, so the two don't drift into two slightly different UIs for the same feature.
interface VoiceControlsProps {
  supported: boolean;
  listening: boolean;
  speaking: boolean;
  interimTranscript: string;
  autoSpeak: boolean;
  onToggleAutoSpeak: () => void;
  onMicClick: () => void;
  en: boolean;
}

export function VoiceControls({ supported, listening, speaking, interimTranscript, autoSpeak, onToggleAutoSpeak, onMicClick, en }: VoiceControlsProps) {
  if (!supported) return null; // no SpeechRecognition on this browser (e.g. Firefox) — hide, don't show a dead button
  const state = listening ? "listening" : speaking ? "speaking" : "idle";
  const title = listening
    ? (en ? "Listening… tap to stop" : "Écoute en cours… touche pour arrêter")
    : speaking
    ? (en ? "Speaking… tap to interrupt" : "Otto parle… touche pour interrompre")
    : (en ? "Talk to Otto" : "Parler à Otto");
  return (
    <div className="voice-controls">
      {listening && interimTranscript ? <span className="voice-interim">{interimTranscript}</span> : null}
      <button
        type="button"
        className={`voice-mic-btn voice-mic-${state}`}
        onClick={onMicClick}
        title={title}
        aria-label={title}
      >
        {speaking ? "⏸" : "🎙"}
      </button>
      <button
        type="button"
        className={`voice-autospeak-btn ${autoSpeak ? "active" : ""}`}
        onClick={onToggleAutoSpeak}
        title={en ? "Speak Otto's replies aloud" : "Lire les réponses d'Otto à voix haute"}
        aria-pressed={autoSpeak}
      >
        {autoSpeak ? "🔊" : "🔇"}
      </button>
    </div>
  );
}
