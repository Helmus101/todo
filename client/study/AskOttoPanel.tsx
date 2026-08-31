import { useRef, useEffect, useState, useCallback } from "react";
import type { WebTask } from "../../shared/types.ts";
import { renderChatText, stripStrayMarkdown } from "../ui.tsx";

interface AskOttoPanelProps {
  task: WebTask;
  currentStep: { text: string } | undefined;
  input: string;
  setInput: (v: string) => void;
  sending: boolean;
  error: string | null;
  pendingMsg: string | null;
  slow: boolean;
  verySlow: boolean;
  onSend: () => void;
  onOpenNote: (id: string, title: string) => void;
  onOpenDeck: (id: string, title: string) => void;
  onOpenQuiz: (id: string, title: string) => void;
  /** Opt-in mic input + read-aloud — Settings' "Voice chat with Otto" toggle (Profile.voiceChat). Built on
   *  the browser's own Web Speech API (SpeechRecognition for input, speechSynthesis for read-aloud) rather
   *  than a hosted or self-hosted STT/TTS service: this is the one way to offer voice at genuinely zero
   *  marginal cost on a serverless deployment with no persistent compute to host a model on. */
  voiceChat?: boolean;
}

// SpeechRecognition is still vendor-prefixed in some browsers (Chrome/Edge/Safari) and entirely absent in
// Firefox — feature-detect once rather than assuming, so the mic button just doesn't render where it can't
// work instead of throwing when clicked.
type SpeechRecognitionCtor = new () => any;
function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

// Mirrors TaskCard.tsx's TaskChat exactly (same pending-echo/typing-dots/slow-hint/error-retry state
// machine, same markdown rendering) — a student should get the identical tutoring experience whether
// they're on the main task card or inside Study Mode, not a stripped-down copy.
// Renders just the chat body/input — no drawer chrome of its own. It's embedded inside a movable/resizable
// "chat" artifact (ChatArtifact.tsx → ArtifactCanvas.tsx) rather than docked to a fixed side panel like the
// other drawers, so the title bar/close/drag/resize handles all come from ArtifactCanvas's generic wrapper.
export function AskOttoPanel({
  task, currentStep, input, setInput, sending, error, pendingMsg, slow, verySlow, onSend,
  onOpenNote, onOpenDeck, onOpenQuiz, voiceChat,
}: AskOttoPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const [listening, setListening] = useState(false);
  const [speakingIdx, setSpeakingIdx] = useState<number | null>(null);
  const canListen = !!voiceChat && !!getSpeechRecognitionCtor();
  const canSpeak = !!voiceChat && typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [task.chat?.length, sending]);

  // Stop any in-flight mic/speech the moment voice chat is turned off or the panel unmounts — nothing
  // should keep listening or talking in the background once the student leaves this drawer.
  useEffect(() => () => {
    recognitionRef.current?.stop();
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  const toggleListen = useCallback(() => {
    if (listening) { recognitionRef.current?.stop(); return; }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = document.documentElement.lang === "en" ? "en-US" : "fr-FR";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      const text = Array.from(e.results as any).map((r: any) => r[0]?.transcript || "").join(" ").trim();
      if (text) setInput(text);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }, [listening, setInput]);

  const speak = useCallback((idx: number, text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    if (speakingIdx === idx) { setSpeakingIdx(null); return; }
    const utter = new SpeechSynthesisUtterance(stripStrayMarkdown(text));
    utter.lang = document.documentElement.lang === "en" ? "en-US" : "fr-FR";
    utter.onend = () => setSpeakingIdx(null);
    utter.onerror = () => setSpeakingIdx(null);
    setSpeakingIdx(idx);
    window.speechSynthesis.speak(utter);
  }, [speakingIdx]);

  return (
    <div className="sm-ai-embed">
      <div className="sm-ai-chat" role="log" aria-live="polite" aria-label="Conversation with Otto">
        {!task.chat?.length && !pendingMsg ? (
          <p className="sm-ai-empty">
            Ask anything about {currentStep ? `"${currentStep.text}"` : task.title}.
          </p>
        ) : task.chat?.map((m, i) => (
          <div key={i} className={`sm-ai-msg sm-ai-msg-${m.role}`}>
            <span className={`sm-ai-sender sm-ai-sender-${m.role}`}>{m.role === "user" ? "You" : "Otto"}</span>
            {m.role === "user" && m.stepText ? <span className="sm-ai-step-tag">Step {(m.stepIndex ?? 0) + 1} · {m.stepText}</span> : null}
            {/* renderChatText returns its own <p>/<ul> blocks — must NOT be wrapped in another <p> (invalid
                nesting silently breaks paragraph spacing, browsers auto-close the outer tag). */}
            {m.role === "assistant" ? renderChatText(m.text) : <p>{m.text}</p>}
            {m.artifacts?.length ? (
              <div className="sm-ai-artifact-chips">
                {m.artifacts.map((a) => {
                  const exists = a.kind === "note" ? task.notes?.some((n) => n.id === a.id)
                    : a.kind === "deck" ? task.flashcards?.some((f) => f.id === a.id)
                    : task.quizzes?.some((q) => q.id === a.id);
                  if (!exists) return null;
                  const open = a.kind === "note" ? onOpenNote : a.kind === "deck" ? onOpenDeck : onOpenQuiz;
                  return <button key={a.id} type="button" className="sm-btn sm-btn-ghost sm-btn-sm" onClick={() => open(a.id, a.title)}>{a.title}</button>;
                })}
              </div>
            ) : null}
            {m.role === "assistant" && m.guardrail ? (
              <span className="sm-ai-guardrail-tag">Otto guides, doesn't do it for you</span>
            ) : null}
            {m.role === "assistant" && canSpeak ? (
              <button type="button" className="sm-btn sm-btn-ghost sm-btn-sm sm-ai-speak" aria-label={speakingIdx === i ? "Stop reading aloud" : "Read aloud"} onClick={() => speak(i, m.text)}>
                {speakingIdx === i ? "◼ Stop" : "▶ Listen"}
              </button>
            ) : null}
          </div>
        ))}
        {pendingMsg ? <div className="sm-ai-msg sm-ai-msg-user sm-ai-msg-pending">{pendingMsg}</div> : null}
        {sending ? (
          <div className="sm-ai-msg sm-ai-msg-assistant sm-ai-typing" role="status" aria-label="Otto is thinking">
            <span className="sm-typing-dots" aria-hidden="true"><i /><i /><i /></span>
            {verySlow ? <span className="sm-typing-slow">might be putting something together…</span>
              : slow ? <span className="sm-typing-slow">still thinking…</span> : null}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      {error ? (
        <div className="sm-ai-error">
          {error}
          <button type="button" className="sm-btn sm-btn-ghost sm-btn-sm" onClick={onSend} disabled={sending}>Retry</button>
        </div>
      ) : null}

      <div className="sm-ai-input-row">
        <input
          ref={inputRef}
          className="sm-ai-input"
          type="text"
          aria-label="Your message to Otto"
          placeholder="What do you need help with?"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onSend(); } }}
          disabled={sending}
          autoFocus
        />
        {canListen ? (
          <button type="button" className={`sm-btn sm-btn-ghost sm-ai-mic ${listening ? "sm-ai-mic-active" : ""}`} aria-pressed={listening} aria-label={listening ? "Stop listening" : "Speak your message"} onClick={toggleListen} disabled={sending}>
            {listening ? "◼" : "●"}
          </button>
        ) : null}
        <button className="sm-btn sm-btn-primary" onClick={onSend} disabled={sending || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
