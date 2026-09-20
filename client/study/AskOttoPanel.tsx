import { useRef, useEffect, useContext } from "react";
import { Grid2x2 } from "lucide-react";
import type { WebTask } from "../../shared/types.ts";
import { renderChatText, useThinkingWord, useLang, LangContext, CondensedUserMessage, FirstTimeHint } from "../ui.tsx";
import { useSpeechRecognition } from "../voice/useSpeechRecognition.ts";
import { useSpeechSynthesis } from "../voice/useSpeechSynthesis.ts";
import { useVoiceModePref } from "../voice/useVoiceModePref.ts";
import { VoiceControls } from "../voice/VoiceControls.tsx";
import { InlineProblem } from "./InlineProblem.tsx";
import { useCanvasModePref } from "./useCanvasModePref.ts";
import { CanvasProblem } from "./CanvasProblem.tsx";

interface AskOttoPanelProps {
  task: WebTask;
  currentStep: { text: string } | undefined;
  input: string;
  setInput: (v: string) => void;
  sending: boolean;
  error: string | null;
  pendingMsg: string | null;
  onSend: (override?: string, voiceMode?: boolean, canvasMode?: boolean) => void;
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
  const thinkingWord = useThinkingWord(sending);
  const en = useContext(LangContext) === "en";
  const speechLang = en ? "en-US" : "fr-FR";
  const synth = useSpeechSynthesis(speechLang);
  const [voiceModeOn, toggleVoiceMode] = useVoiceModePref();
  const [canvasModeOn, toggleCanvasMode] = useCanvasModePref();
  const L = useLang();
  // Fires per detected utterance while listening — ignore a stray recognition result that lands while a
  // previous message is still in flight rather than firing a second send on top of it.
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const recog = useSpeechRecognition({ lang: speechLang, onResult: (text) => { if (!sendingRef.current) onSend(text, true, canvasModeOn); } });
  // The problem currently "on the canvas" — the most recently created one (CREATE_PROBLEM appends to
  // task.problems in order, so the last entry is always the active/most-recent problem; Otto's own prompt
  // instructions — see chatAboutTask's CANVAS MODE block — keep working THIS one until it's actually solved
  // before making a new one, so "most recent" and "active" are the same thing in practice). Only shown
  // pinned above the thread while canvas mode is on; irrelevant otherwise.
  const activeProblem = canvasModeOn && task.problems?.length ? task.problems[task.problems.length - 1] : undefined;
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
    if (synth.speaking && !wasSpeakingRef.current) recog.stop();
    else if (!synth.speaking && wasSpeakingRef.current) recog.start();
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
  // A one-shot spoken filler for the wait — NOT the cycling thinking-word text (that changes every 1.4s;
  // speaking a new phrase every 1.4s would be unusable), just a single line so a voice-mode student isn't
  // sitting in total silence during the 15-20s+ a multi-step tutor turn can take (see runTask's own latency
  // notes in server/claude.ts — this app has no streaming yet, so the reply arrives as one block). Real
  // replies in voice mode are also told server-side (the `voiceMode` flag sent with the message) to answer
  // in 2-3 short spoken sentences, so this filler is covering seconds, not the old worst-case full length.
  const spokenFillerRef = useRef(false);
  useEffect(() => {
    if (sending && voiceModeOn && !spokenFillerRef.current) {
      synth.speak(en ? "Let me think about that." : "Laisse-moi réfléchir.");
      spokenFillerRef.current = true;
    }
    if (!sending) spokenFillerRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, voiceModeOn]);
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

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [task.chat?.length, sending]);

  return (
    <div className="sm-ai-embed">
      <div className="sm-ai-mode-row">
        <button
          type="button"
          className={`sm-btn sm-btn-ghost sm-btn-sm sm-canvas-toggle ${canvasModeOn ? "is-on" : ""}`}
          onClick={toggleCanvasMode}
          aria-pressed={canvasModeOn}
          title={L(
            "Mode canevas : un problème à la fois, avec les étapes affichées au-dessus du chat",
            "Canvas mode: one problem at a time, with the steps pinned above the chat",
          )}
        >
          <Grid2x2 size={13} strokeWidth={2} />
          {L("Mode canevas", "Canvas mode")}
        </button>
      </div>

      {canvasModeOn && (
        <FirstTimeHint
          id="canvas-mode"
          title={L("Mode canevas", "Canvas mode")}
          body={L(
            "Otto travaille un problème à la fois avec toi, sans jamais créer de fiche, deck ou quiz complet — le problème reste épinglé au-dessus du chat pendant que tu le résous.",
            "Otto works one problem at a time with you, without ever creating a whole note, deck, or quiz — the problem stays pinned above the chat while you work through it.",
          )}
        />
      )}
      {canvasModeOn && activeProblem ? (
        <CanvasProblem problem={activeProblem} />
      ) : canvasModeOn ? (
        <div className="sm-canvas-empty">
          {L(
            "Envoie un message pour qu'Otto pose le premier problème sur le canevas.",
            "Send a message and Otto will put the first problem on the canvas.",
          )}
        </div>
      ) : null}

      <div className="sm-ai-chat" role="log" aria-live="polite" aria-label="Conversation with Otto">
        {!task.chat?.length && !pendingMsg ? (
          <p className="sm-ai-empty">
            {canvasModeOn
              ? L("Dis à Otto sur quoi tu veux t'entraîner.", "Tell Otto what you want to practice.")
              : `Ask anything about ${currentStep ? `"${currentStep.text}"` : task.title}.`}
          </p>
        ) : task.chat?.map((m, i) => (
          <div key={i} className={`sm-ai-msg sm-ai-msg-${m.role}`}>
            <span className={`sm-ai-sender sm-ai-sender-${m.role}`}>{m.role === "user" ? "You" : "Otto"}</span>
            {m.role === "user" && m.stepText ? <span className="sm-ai-step-tag">Step {(m.stepIndex ?? 0) + 1} · {m.stepText}</span> : null}
            {/* renderChatText returns its own <p>/<ul> blocks — must NOT be wrapped in another <p> (invalid
                nesting silently breaks paragraph spacing, browsers auto-close the outer tag). */}
            {m.role === "assistant" ? renderChatText(m.text) : <p><CondensedUserMessage text={m.text} /></p>}
            {/* In canvas mode the active problem is already pinned above (CanvasProblem) — rendering it a
                second time inline here would just duplicate it under every message that mentions it. */}
            {!canvasModeOn && m.artifacts?.filter((a) => a.kind === "problem").map((a) => {
              const problem = task.problems?.find((p) => p.id === a.id);
              if (!problem) return null;
              return <InlineProblem key={a.id} problem={problem} />;
            })}
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
          <button type="button" className="sm-btn sm-btn-ghost sm-btn-sm" onClick={() => onSend(undefined, voiceModeOn, canvasModeOn)} disabled={sending}>Retry</button>
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
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(undefined, voiceModeOn, canvasModeOn); } }}
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
        <button className="sm-btn sm-btn-primary" onClick={() => onSend(undefined, voiceModeOn, canvasModeOn)} disabled={sending || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
