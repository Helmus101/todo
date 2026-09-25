import { useRef, useEffect, useContext, useCallback } from "react";
import type { WebTask } from "../../shared/types.ts";
import { renderChatText, useThinkingWord, useLang, LangContext, CondensedUserMessage, FirstTimeHint } from "../ui.tsx";
import { useSpeechRecognition } from "../voice/useSpeechRecognition.ts";
import { useSpeechSynthesis } from "../voice/useSpeechSynthesis.ts";
import { useVoiceModePref } from "../voice/useVoiceModePref.ts";
import { VoiceControls } from "../voice/VoiceControls.tsx";
import { InlineProblem } from "./InlineProblem.tsx";

interface AskOttoPanelProps {
  task: WebTask;
  currentStep: { text: string } | undefined;
  input: string;
  setInput: (v: string) => void;
  sending: boolean;
  error: string | null;
  pendingMsg: string | null;
  onSend: (override?: string, voiceMode?: boolean) => void;
  onOpenNote: (id: string, title: string) => void;
  onOpenDeck: (id: string, title: string) => void;
  onOpenQuiz: (id: string, title: string) => void;
}

// Mirrors TaskCard.tsx's TaskChat exactly (same pending-echo/typing-dots/slow-hint/error-retry state
// machine, same markdown rendering) — a student should get the identical tutoring experience whether
// they're on the main task card or inside Study Mode, not a stripped-down copy.
// Renders just the chat body/input — no drawer chrome of its own. It's embedded inside a movable/resizable
// "chat" artifact (ChatArtifact.tsx → ArtifactCanvas.tsx) rather than docked to a fixed side panel like the
// other drawers, so the title bar/close/drag/resize handles all come from ArtifactCanvas's generic wrapper.
export function AskOttoPanel({
  task, currentStep, input, setInput, sending, error, pendingMsg, onSend,
  onOpenNote, onOpenDeck, onOpenQuiz,
}: AskOttoPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const thinkingWord = useThinkingWord(sending);
  const en = useContext(LangContext) === "en";
  const speechLang = en ? "en-US" : "fr-FR";
  const synth = useSpeechSynthesis(speechLang);
  const [voiceModeOn, toggleVoiceMode] = useVoiceModePref();
  const L = useLang();
  // Fires per detected utterance while listening — ignore a stray recognition result that lands while a
  // previous message is still in flight rather than firing a second send on top of it.
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const recog = useSpeechRecognition({ lang: speechLang, onResult: (text) => { if (!sendingRef.current) onSend(text, true); } });
  // The problem currently active — the most recently created one (CREATE_PROBLEM appends to
  // task.problems in order, so the last entry is always the active/most-recent problem; Otto's own prompt
  // instructions keep working THIS one until it's actually solved before making a new one, so "most recent" 
  // and "active" are the same thing in practice). Problems are now shown in the Board artifact instead of
  // a separate canvas.
  const activeProblem = task.problems?.length ? task.problems[task.problems.length - 1] : undefined;
  // Voice mode is ONE switch: on = always listening (no push-to-talk tap needed between turns) AND
  // auto-speaking replies. Turning it on starts listening immediately; turning it off stops everything.
  useEffect(() => {
    if (voiceModeOn) recog.start();
    else { recog.abort(); synth.cancel(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceModeOn]);
  // Pause listening while Otto is actually talking (avoids the mic picking up Otto's own voice from the
  // speakers and treating it as the next thing to respond to), and resume the instant he's done — the
  // whole point of "always on" is the student never has to tap anything between turns.
  const wasSpeakingRef = useRef(false);
  useEffect(() => {
    if (!voiceModeOn) return;
    // abort() (not stop()) so no buffered audio from the moment TTS starts gets finalized into a result,
    // and a short settle delay before restarting so speaker echo has time to die down before the mic
    // reopens — without both, Otto's own voice was occasionally getting transcribed and re-sent as if the
    // student had said it. See the identical fix in TaskCard.tsx's TaskChat for the full explanation.
    if (synth.speaking && !wasSpeakingRef.current) {
      recog.abort();
    } else if (!synth.speaking && wasSpeakingRef.current) {
      const t = setTimeout(() => { if (voiceModeOn && !synth.speaking) recog.start(); }, 400);
      wasSpeakingRef.current = synth.speaking;
      return () => clearTimeout(t);
    }
    wasSpeakingRef.current = synth.speaking;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synth.speaking, voiceModeOn]);
  // Speak the reply once it arrives — tracked by chat length so a re-render (not a new message) never
  // re-triggers it, and so turning voice mode on mid-conversation only speaks FUTURE replies, not the
  // whole history at once.
  const spokenCountRef = useRef(0);
  useEffect(() => {
    const chat = task.chat || [];
    if (chat.length > spokenCountRef.current) {
      const last = chat[chat.length - 1];
      if (voiceModeOn && last?.role === "assistant") synth.speak(last.text);
    }
    spokenCountRef.current = chat.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.chat?.length, voiceModeOn]);
  // Grows up to 3 lines (CSS max-height on .sm-ai-input) then scrolls internally — was a single-line
  // <input>, so anything longer than one line just scrolled sideways out of view while typing. Re-measured
  // on every `input` change (typing AND a programmatic clear after send), not just onChange, so sending a
  // message correctly shrinks it back to one line instead of staying tall with nothing in it.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Auto-scroll to bottom — always. The chat should never hide the latest message.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [task.chat?.length, sending, pendingMsg]);
  
  // Track user scroll intention
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    userScrolledRef.current = !isNearBottom;
  }, []);

  return (
    <div className="sm-ai-embed">
      <div className="sm-ai-chat" role="log" aria-live="polite" aria-label="Conversation with Otto" ref={chatContainerRef} onScroll={handleScroll}>
        {!task.chat?.length && !pendingMsg ? (
          <p className="sm-ai-empty">
            {`Ask anything about ${currentStep ? `"${currentStep.text}"` : task.title}.`}
          </p>
        ) : task.chat?.map((m, i) => (
          <div key={i} className={`sm-ai-msg sm-ai-msg-${m.role}`}>
            <span className={`sm-ai-sender sm-ai-sender-${m.role}`}>{m.role === "user" ? "You" : "Otto"}</span>
            {m.role === "user" && m.stepText ? <span className="sm-ai-step-tag">Step {(m.stepIndex ?? 0) + 1} · {m.stepText}</span> : null}
            {/* renderChatText returns its own <p>/<ul> blocks — must NOT be wrapped in another <p> (invalid
                nesting silently breaks paragraph spacing, browsers auto-close the outer tag). */}
            {m.role === "assistant" ? renderChatText(m.text) : <p><CondensedUserMessage text={m.text} /></p>}
            {/* Problems are now shown in the Board artifact instead of inline */}
            {m.artifacts?.filter((a) => a.kind !== "problem")?.length ? (
              <div className="sm-ai-artifact-chips">
                {m.artifacts.filter((a) => a.kind !== "problem").map((a) => {
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
          </div>
        ))}
        {pendingMsg ? <div className="sm-ai-msg sm-ai-msg-user sm-ai-msg-pending">{pendingMsg}</div> : null}
        {sending ? (
          <div className="sm-ai-msg sm-ai-msg-assistant sm-ai-typing" role="status" aria-label="Otto is thinking">
            <span className="sm-typing-dots" aria-hidden="true"><i /><i /><i /></span>
            {/* The cycling word itself already reads as "still actively working" (it keeps changing), so it
                replaces the old static "still thinking…"/"might be putting something together…" text
                entirely rather than stacking both — verySlow still extends the interval-checking useEffect
                lifetime the same as before, just no longer needs its own separate line. */}
            {thinkingWord ? <span className="sm-typing-slow">{thinkingWord}…</span> : null}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      {error ? (
        <div className="sm-ai-error">
          {error}
          <button type="button" className="sm-btn sm-btn-ghost sm-btn-sm" onClick={() => onSend(undefined, voiceModeOn)} disabled={sending}>Retry</button>
        </div>
      ) : null}

      <div className="sm-ai-input-row">
        <textarea
          ref={inputRef}
          className="sm-ai-input"
          rows={1}
          aria-label="Your message to Otto"
          placeholder="What do you need help with?"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(undefined, voiceModeOn); } }}
          disabled={sending}
          autoFocus
        />
        <VoiceControls
          supported={recog.supported}
          voiceModeOn={voiceModeOn}
          listening={recog.listening}
          speaking={synth.speaking}
          interimTranscript={recog.interimTranscript}
          onToggle={toggleVoiceMode}
          en={en}
        />
        <button className="sm-btn sm-btn-primary" onClick={() => onSend(undefined, voiceModeOn)} disabled={sending || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
