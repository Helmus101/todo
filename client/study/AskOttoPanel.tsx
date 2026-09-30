import { useRef, useEffect, useState, useContext, useCallback } from "react";
import type { WebTask } from "../../shared/types.ts";
import { renderChatText, useThinkingWord, useLang, LangContext, CondensedUserMessage, FirstTimeHint } from "../ui.tsx";
import { useSpeechRecognition } from "../voice/useSpeechRecognition.ts";
import { useSpeechSynthesis } from "../voice/useSpeechSynthesis.ts";
import { useVoiceModePref } from "../voice/useVoiceModePref.ts";
import { VoiceControls } from "../voice/VoiceControls.tsx";
import { createEchoFilter } from "../voice/echoGuard.ts";
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
  /** Optional overrides (Tutor Session) for the empty-state line and input placeholder. */
  emptyText?: string;
  placeholder?: string;
  /** Tutor Session only — a spoken lesson is the whole premise of that surface (unlike a normal per-task
   *  chat, which is text-first with voice as an opt-in extra), so it starts the session already listening
   *  instead of making the student find and tap the mic toggle themselves. Applied once, on mount, via the
   *  SAME toggle a manual tap would use — never forces it back on if the student explicitly turns it off.
   *  Requested, not guaranteed: browsers with no SpeechRecognition (Firefox) stay text-first — voiceModeOn
   *  is never force-enabled where there's no microphone support at all. */
  startInVoiceMode?: boolean;
  /** Tutor Session only — reports the voice loop's state upward ({@link TutorSession}) so the BOARD pane
   *  (not just the chat's mic button) can show Listening…/Speaking…/Voice on. In a voice-first session the
   *  student's eyes are on the board, not the chat input — the state indicator has to live where they look. */
  onVoiceStateChange?: (state: { listening: boolean; speaking: boolean; voiceModeOn: boolean; interim: string }) => void;
  /** Tutor Session only — barge-in: while Otto is speaking, an interim recognition transcript of at least
   *  this many words cancels the speech immediately so the student can interrupt mid-sentence, exactly like
   *  talking over a human tutor. Two words, not one: a single word ("okay", "yes") is too easy to
   *  false-trigger from speaker echo or a throat-clear; two real words is intent. Kept local to Tutor
   *  Session — the per-task chat in TaskCard.tsx keeps its pause-and-resume behavior. */
  bargeIn?: boolean;
}

// The text currently being spoken aloud (the newest assistant reply) — the echo guard's reference: Otto
// can only echo words he is saying right now, so anything he isn't saying is the student.
function speakingNowText(task: WebTask): string {
  const chat = task.chat || [];
  return chat.length ? chat[chat.length - 1]?.text || "" : "";
}

// Mirrors TaskCard.tsx's TaskChat exactly (same pending-echo/typing-dots/slow-hint/error-retry state
// machine, same markdown rendering) — a student should get the identical tutoring experience whether
// they're on the main task card or inside Study Mode, not a stripped-down copy.
// Renders just the chat body/input — no drawer chrome of its own. It's embedded inside a movable/resizable
// "chat" artifact (ChatArtifact.tsx → ArtifactCanvas.tsx) rather than docked to a fixed side panel like the
// other drawers, so the title bar/close/drag/resize handles all come from ArtifactCanvas's generic wrapper.
export function AskOttoPanel({
  task, currentStep, input, setInput, sending, error, pendingMsg, onSend,
  onOpenNote, onOpenDeck, onOpenQuiz, emptyText, placeholder, startInVoiceMode, onVoiceStateChange, bargeIn,
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
  // Applied once — a ref (not state) so it can never re-fire and fight a student who deliberately turns
  // voice mode back off mid-session.
  const autoVoiceAppliedRef = useRef(false);
  const recogSupportedRef = useRef(false);
  useEffect(() => {
    // Only flip the pref when SpeechRecognition actually exists here — force-enabling voice mode on
    // Firefox (no recognition support; VoiceControls hides itself) would leave the student in a state
    // where Otto speaks but can never hear them, with no mic button to turn it off with.
    if (startInVoiceMode && !voiceModeOn && !autoVoiceAppliedRef.current && recogSupportedRef.current) {
      autoVoiceAppliedRef.current = true;
      toggleVoiceMode();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startInVoiceMode]);
  const L = useLang();
  // Fires per detected utterance while listening — ignore a stray recognition result that lands while a
  // previous message is still in flight rather than firing a second send on top of it.
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  // Barge-in refs — recognition's callbacks need the CURRENT speaking state and the text being spoken,
  // and useSpeechRecognition's options object is captured at hook-setup time, so plain closures over
  // synth.speaking / the last chat message would go stale.
  const speakingRef = useRef(false);
  speakingRef.current = synth.speaking;
  // THE LOOP-KILLER (the recurring "Otto hears himself" bug). The old guard only checked echo WHILE
  // synth.speaking was true — but recognition lag means Otto's echo routinely FINALIZES after the flag
  // already flipped false, exactly when the check was skipped, so his own reply went out as a student
  // message, Otto replied to it, the reply was spoken, re-echoed, re-sent… The stateful filter
  // (createEchoFilter, client/voice/echoGuard.ts) classifies across the whole speech window PLUS a tail
  // after it, and drops a verbatim repeat of the just-spoken reply regardless of timing.
  const echoFilterRef = useRef(createEchoFilter());
  const [micError, setMicError] = useState<[string, string] | null>(null);
  const recog = useSpeechRecognition({
    lang: speechLang,
    onResult: (text) => {
      if (sendingRef.current) return;
      // Otto's own voice coming back (during speech, in the post-speech tail, or verbatim) is NEVER input.
      if (echoFilterRef.current.isEcho(text)) return;
      // Real student speech while Otto talks: interrupt him — cancel the TTS, the utterance still sends.
      if (speakingRef.current && bargeIn) synth.cancel();
      onSend(text, true);
    },
    // Live barge-in channel: interim text streams in while the student is still talking — cancel the TTS
    // the instant real speech is detected. Echo-filtered so Otto doesn't cancel himself.
    onInterim: (text) => {
      if (!bargeIn || !text) return;
      if (echoFilterRef.current.isEcho(text)) return;
      if (speakingRef.current && text.trim().split(/\s+/).length >= 2) synth.cancel();
    },
    // Mic failures used to vanish silently (a blocked mic looked like "listening, heard nothing") — now
    // they surface as a real, bilingual, student-presentable message.
    onError: (msg) => setMicError(msg),
  });
  // Drive the echo filter's windows from the TTS transitions: speechStarted re-arms on every new
  // utterance (with the text being spoken — the echo reference), speechEnded opens the post-speech tail.
  const wasSpeakingEchoRef = useRef(false);
  useEffect(() => {
    if (synth.speaking && !wasSpeakingEchoRef.current) echoFilterRef.current.speechStarted(speakingNowText(task));
    else if (!synth.speaking && wasSpeakingEchoRef.current) echoFilterRef.current.speechEnded();
    wasSpeakingEchoRef.current = synth.speaking;
  }, [synth.speaking, task]);
  // Assigned only AFTER recog exists — the mount-time autoVoice effect above reads this ref (it must never
  // touch recog directly: recog is declared below that effect, so a direct use would be a TDZ crash).
  recogSupportedRef.current = recog.supported;
  // Report voice-loop state upward (board-pane pill in Tutor Session) on every change. Fired from an
  // effect, not inline in render, so a parent setState during this child's render never happens.
  useEffect(() => {
    onVoiceStateChange?.({ listening: recog.listening, speaking: synth.speaking, voiceModeOn, interim: recog.interimTranscript });
  }, [recog.listening, synth.speaking, voiceModeOn, recog.interimTranscript, onVoiceStateChange]);
  // The problem currently active — the most recently created one (CREATE_PROBLEM appends to
  // task.problems in order, so the last entry is always the active/most-recent problem; Otto's own prompt
  // instructions keep working THIS one until it's actually solved before making a new one, so "most recent" 
  // and "active" are the same thing in practice). Problems are now shown in the Board artifact instead of
  // a separate canvas.
  const activeProblem = task.problems?.length ? task.problems[task.problems.length - 1] : undefined;
  // Voice mode is ONE switch: on = always listening (no push-to-talk tap needed between turns) AND
  // auto-speaking replies. Turning it on starts listening immediately; turning it off stops everything.
  // A fresh toggle-on also clears any stale mic error from a previous failed attempt.
  useEffect(() => {
    if (voiceModeOn) { setMicError(null); recog.start(); }
    else { recog.abort(); synth.cancel(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceModeOn]);
  // Barge-in keeps the mic OPEN while Otto talks — the student's voice has to reach a live recognizer for
  // an interruption to exist at all (the old pause-the-mic-during-TTS design made barge-in structurally
  // impossible: abort() killed the recognizer, so nothing the student said while Otto spoke was ever
  // heard). Echo from the speakers is handled by isLikelyEcho above, not by deafness. When barge-in is
  // OFF (Study Mode / per-task chats), keep the old pause-and-resume behavior: safer against echo on
  // devices without headphones, and there's nothing to interrupt anyway. The 400ms settle delay before
  // reopening stays for the non-barge-in path (see TaskCard.tsx's identical effect for the full history).
  const wasSpeakingRef = useRef(false);
  useEffect(() => {
    if (!voiceModeOn || bargeIn) return;
    if (synth.speaking && !wasSpeakingRef.current) {
      recog.abort();
    } else if (!synth.speaking && wasSpeakingRef.current) {
      const t = setTimeout(() => { if (voiceModeOn && !synth.speaking) recog.start(); }, 400);
      wasSpeakingRef.current = synth.speaking;
      return () => clearTimeout(t);
    }
    wasSpeakingRef.current = synth.speaking;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synth.speaking, voiceModeOn, bargeIn]);
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
      <div className="sm-ai-chat" role="log" aria-live="polite" aria-label={L("Conversation avec Otto", "Conversation with Otto")} ref={chatContainerRef} onScroll={handleScroll}>
        {!task.chat?.length && !pendingMsg ? (
          <p className="sm-ai-empty">
            {emptyText ?? `Ask anything about ${currentStep ? `"${currentStep.text}"` : task.title}.`}
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
          <div className="sm-ai-msg sm-ai-msg-assistant sm-ai-typing" role="status" aria-label={L("Otto réfléchit", "Otto is thinking")}>
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
      {/* Real mic failure surfacing (permission denied, no mic, network) — previously silent. */}
      {micError ? <div className="sm-ai-error" role="alert">{L(micError[0], micError[1])}</div> : null}

      <div className="sm-ai-input-row">
        <textarea
          ref={inputRef}
          className="sm-ai-input"
          rows={1}
          aria-label={L("Ton message à Otto", "Your message to Otto")}
          placeholder={placeholder ?? L("De quoi as-tu besoin ?", "What do you need help with?")}
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
          {L("Envoyer", "Send")}
        </button>
      </div>
    </div>
  );
}
