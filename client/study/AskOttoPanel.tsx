import { useRef, useEffect, useState, useContext, useCallback } from "react";
import type { WebTask } from "../../shared/types.ts";
import { renderChatText, useThinkingWord, useLang, LangContext, CondensedUserMessage, FirstTimeHint, useNotify } from "../ui.tsx";
import { useSpeechRecognition } from "../voice/useSpeechRecognition.ts";
import { useSpeechSynthesis } from "../voice/useSpeechSynthesis.ts";
import { lastMessageKey } from "../voice/replyKey.ts";
import { useVoiceModePref } from "../voice/useVoiceModePref.ts";
import { VoiceControls } from "../voice/VoiceControls.tsx";
import { createEchoFilter } from "../voice/echoGuard.ts";
import { findArithmeticClaims } from "../../server/arithmetic.ts";
import { InlineProblem } from "./InlineProblem.tsx";
import { extractPdfText } from "./pdfText.ts";
import { api } from "../api.ts";
import { OttoAvatar } from "../tutor/OttoAvatar.tsx";

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
  /** "dock" (Tutor stage): no transcript at all — Otto is just his avatar plus the LATEST answer in one
   *  bubble, and the student's input sits right under it. Every voice/echo/send behavior is shared with the
   *  full chat; only the rendering differs. */
  variant?: "chat" | "dock";
}

// The text currently being spoken aloud (the newest assistant reply) — the echo guard's reference: Otto
// can only echo words he is saying right now, so anything he isn't saying is the student.
function speakingNowText(task: WebTask): string {
  const chat = task.chat || [];
  return chat.length ? chat[chat.length - 1]?.text || "" : "";
}

// PHASE 4 of the tutor-truth work: an independent, client-side double-check of every arithmetic
// equality Otto asserts, using the SAME deterministic evaluator the server verifies with
// (server/arithmetic.ts — pure, no imports, so it bundles client-side unchanged; one oracle, two
// callers, exactly the CRITIC/CoVe posture). The server's own post-reply pass already rewrites
// wrong arithmetic before it ever ships — so a mismatch that STILL reaches the client means the
// verifier never ran (deadline hit, ceiling hit, older saved message). This renders that residue
// visible instead of silent: a small "double-check this" notice under the message, with the claim
// and both values. Deliberately a LEARNING SIGNAL, not an error banner, and never auto-corrected:
// spotting the discrepancy IS the exercise, and the student takes it to Otto. localStorage history
// re-checks too — the notice appears on old sessions' messages where the old model had no verifier.
function arithmeticMismatches(text: string): { raw: string; lhs: string; claimed: number | null; actual: number | null }[] {
  return findArithmeticClaims(text).filter((c) => c.mismatch).map((c) => ({ raw: c.raw, lhs: c.lhs, claimed: c.right, actual: c.left }));
}

// Mirrors TaskCard.tsx's TaskChat exactly (same pending-echo/typing-dots/slow-hint/error-retry state
// machine, same markdown rendering) — a student should get the identical tutoring experience whether
// they're on the main task card or inside Study Mode, not a stripped-down copy.
// Renders just the chat body/input — no drawer chrome of its own. It's embedded inside a movable/resizable
// "chat" artifact (ChatArtifact.tsx → ArtifactCanvas.tsx) rather than docked to a fixed side panel like the
// other drawers, so the title bar/close/drag/resize handles all come from ArtifactCanvas's generic wrapper.
export function AskOttoPanel({
  task, currentStep, input, setInput, sending, error, pendingMsg, onSend,
  onOpenNote, onOpenDeck, onOpenQuiz, emptyText, placeholder, onVoiceStateChange, bargeIn, variant = "chat",
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
  // NO auto-enable, ever: voice mode (mic + auto-speak) starts OFF on every load and only an explicit tap
  // on the mic button turns it on — see useVoiceModePref.ts's product-rule comment. A mount effect that
  // flipped the pref on automatically used to live here; removed along with the persisted pref itself so
  // no code path can open the microphone without the student tapping it.
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
  // File attach — "upload a file into the tutor" (a PDF worksheet, a photo of an exercise, a plain text
  // note): three file types need three different extraction paths, but all three land the same way —
  // appended into the textarea as quoted context ahead of whatever the student types, so they can still
  // add their own question on top before sending, nothing auto-sends on its own.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attaching, setAttaching] = useState(false);
  const notify = useNotify();
  const MAX_ATTACH_CHARS = 6000;
  const appendAttachment = (label: string, text: string) => {
    const block = `[${label}]\n"""\n${text.trim().slice(0, MAX_ATTACH_CHARS)}\n"""\n\n`;
    setInput(block + input);
  };
  const onAttachFile = async (file: File) => {
    setAttaching(true);
    try {
      if (file.type === "application/pdf") {
        const text = await extractPdfText(file);
        if (!text) { notify(L("Impossible de lire ce PDF (page scannée sans texte ?).", "Couldn't read that PDF (a scanned page with no text layer?)."), "error"); return; }
        appendAttachment(file.name, text);
      } else if (file.type.startsWith("image/")) {
        const dataUrl: string = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        const { description } = await api.readPhoto(dataUrl);
        appendAttachment(file.name, description);
      } else if (file.type.startsWith("text/") || /\.(txt|md)$/i.test(file.name)) {
        appendAttachment(file.name, await file.text());
      } else {
        notify(L("Type de fichier non pris en charge — PDF, image ou texte uniquement.", "Unsupported file type — PDF, image, or plain text only."), "error");
        return;
      }
      inputRef.current?.focus();
    } catch (e: any) {
      notify(e?.message || L("Impossible de lire ce fichier — réessaie.", "Couldn't read that file — try again."), "error");
    } finally {
      setAttaching(false);
    }
  };
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
  // devices without headphones, and there's nothing to interrupt anyway. Reported live: the mic should
  // pick back up the instant Otto stops, not after a noticeable pause — shortened from 400ms to 80ms,
  // just enough for the audio hardware to actually stop outputting before the mic reopens (go to 0 and a
  // genuinely echo-y setup with no headphones could catch the last few ms of playback as a false result;
  // 80ms is below what a student perceives as a delay but still past that window in practice).
  // Reported live: the mic stayed OPEN the whole time Otto's reply was being generated (the `sending`
  // window, before any speech exists) — only `synth.speaking` paused it, so the recognizer kept listening
  // (and could pick up stray noise/an accidental second message) for however long the AI call took. "Busy"
  // now covers BOTH phases — generating AND speaking — for the pause-and-resume (non-barge-in) case. There
  // is never anything to barge INTO before speech starts, so `sending` pauses the mic even when `bargeIn`
  // is on; barge-in's whole point (staying open so the student can interrupt) only applies once Otto is
  // actually talking. Deriving `busy` fresh from current state (not "did speech ever start") also means
  // this self-heals if TTS silently never starts (unsupported browser, empty reply, a swallowed failure):
  // the moment `sending` goes false with speech never having started, `busy` is already false and the mic
  // resumes right away — it can never get stuck off waiting for a speech event that's never coming.
  const wasBusyRef = useRef(false);
  useEffect(() => {
    if (!voiceModeOn) return;
    const busy = sending || (!bargeIn && synth.speaking);
    if (busy && !wasBusyRef.current) {
      recog.abort();
    } else if (!busy && wasBusyRef.current) {
      const t = setTimeout(() => { if (voiceModeOn && !sending && !(!bargeIn && synth.speaking)) recog.start(); }, 80);
      wasBusyRef.current = busy;
      return () => clearTimeout(t);
    }
    wasBusyRef.current = busy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, synth.speaking, voiceModeOn, bargeIn]);
  // Speak each new assistant reply exactly once — keyed on the newest message's IDENTITY, not chat length
  // (see lastMessageKey: the server's chat cap keeps the length constant once a session gets long, which
  // silently stopped all speech). The key is tracked even while voice mode is off, so turning it on
  // mid-conversation only speaks FUTURE replies, never the history.
  const tailKey = lastMessageKey(task.chat);
  const spokenKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (spokenKeyRef.current === null) { spokenKeyRef.current = tailKey; return; } // first render: history
    if (tailKey === spokenKeyRef.current) return;
    spokenKeyRef.current = tailKey;
    const last = task.chat?.[task.chat.length - 1];
    if (voiceModeOn && last?.role === "assistant") {
      console.log("[tts] speaking assistant message:", last.text.slice(0, 60));
      synth.speak(last.text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tailKey, voiceModeOn]);
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

  const diagnostics = (
    <>
      {error ? (
        <div className="sm-ai-error">
          {error}
          <button type="button" className="sm-btn sm-btn-ghost sm-btn-sm" onClick={() => onSend(undefined, voiceModeOn)} disabled={sending}>Retry</button>
        </div>
      ) : null}
      {/* Real mic failure surfacing (permission denied, no mic, network) — previously silent. */}
      {micError ? <div className="sm-ai-error" role="alert">{L(micError[0], micError[1])}</div> : null}
      {/* TTS diagnostic (useSpeechSynthesis's lastDiagnostic): which speech path actually ran and, when it
          fell back, WHY. Voice failures were the last fully-silent surface in this panel — a 501 from a
          missing server key, a CSP-blocked audio element, and a vendor outage all looked like "Otto just
          doesn't talk," indistinguishable from voice mode doing nothing at all. Muted one-liner (not an
          alert): speech DID happen via the fallback, so this explains rather than alarms. Only while voice
          mode is on, so the line never appears in text-only sessions. */}
      {voiceModeOn && synth.lastDiagnostic ? (
        <div className="sm-ai-tts-note" role="status">{synth.lastDiagnostic}</div>
      ) : null}

    </>
  );
  const inputRow = (
    <>
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
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp,text/plain,.md"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onAttachFile(f); e.target.value = ""; }}
        />
        <button
          type="button"
          className="sm-btn sm-btn-ghost sm-btn-sm sm-ai-attach-btn"
          disabled={attaching || sending}
          onClick={() => fileInputRef.current?.click()}
          title={L("Joindre un fichier (PDF, image, texte)", "Attach a file (PDF, image, text)")}
        >
          {attaching ? "…" : "📎"}
        </button>
        <VoiceControls
          supported={recog.supported}
          voiceModeOn={voiceModeOn}
          listening={recog.listening}
          speaking={synth.speaking}
          interimTranscript={recog.interimTranscript}
          // unlock() only matters before the FIRST speak() of a session unlocks autoplay — calling it again
          // on every OFF click too (previously unconditional) meant it fired its own raw
          // speak()/cancel() pair on the real engine at the exact moment the real synth.cancel() effect
          // (keyed on voiceModeOn, one render tick later) was ALSO about to cancel a real in-flight
          // utterance — two uncoordinated callers hitting speechSynthesis back to back, the documented
          // Chrome trigger for a subsequent speak() silently never firing onstart. Reported live as "TTS
          // breaks specifically when I turn the mic off then back on." Only unlock on the ON transition.
          onToggle={() => { if (!voiceModeOn) synth.unlock(); toggleVoiceMode(); }}
          en={en}
        />
        <button className="sm-btn sm-btn-primary" onClick={() => onSend(undefined, voiceModeOn)} disabled={sending || !input.trim()}>
          {L("Envoyer", "Send")}
        </button>
      </div>
    </>
  );

  if (variant === "dock") {
    const lastReply = [...(task.chat || [])].reverse().find((m) => m.role === "assistant");
    const mood = recog.listening && voiceModeOn && !synth.speaking && !sending ? "listening" : synth.speaking ? "speaking" : sending ? "thinking" : "idle";
    const mismatches = lastReply ? arithmeticMismatches(lastReply.text) : [];
    return (
      <div className="otto-dock">
        <div className="otto-dock-row">
          <OttoAvatar mood={mood} size={56} />
          <div className="otto-bubble" role="log" aria-live="polite" aria-label={L("Réponse d'Otto", "Otto's answer")}>
            {sending ? (
              <div className="otto-bubble-thinking" role="status">
                <span className="sm-typing-dots" aria-hidden="true"><i /><i /><i /></span>
                {thinkingWord ? <span className="sm-typing-slow">{thinkingWord}…</span> : null}
              </div>
            ) : lastReply ? (
              <>
                <div className="otto-bubble-text" key={lastMessageKey(task.chat)}>{renderChatText(lastReply.text)}</div>
                {mismatches.length ? (
                  <div className="sm-ai-calc-check" role="note">
                    <span className="sm-ai-calc-check-icon" aria-hidden="true">⚠</span>
                    <span>{L("Vérifie ce calcul avec Otto : ", "Double-check this with Otto: ")}<code>{mismatches[0].raw}</code></span>
                  </div>
                ) : null}
                <button
                  type="button" className="otto-replay"
                  onClick={() => (synth.speaking ? synth.cancel() : (synth.unlock(), synth.speak(lastReply.text)))}
                  title={synth.speaking ? L("Arrêter la voix", "Stop voice") : L("Réécouter", "Listen again")}
                  aria-label={synth.speaking ? L("Arrêter la voix", "Stop voice") : L("Réécouter", "Listen again")}
                >{synth.speaking ? "■" : "🔊"}</button>
              </>
            ) : (
              <p className="otto-bubble-empty">{emptyText ?? ""}</p>
            )}
          </div>
        </div>
        {diagnostics}
        {inputRow}
      </div>
    );
  }

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
                  const icon = a.kind === "note" ? "📝" : a.kind === "deck" ? "🗂️" : "✅";
                  return (
                    <button key={a.id} type="button" className="sm-ai-artifact-chip" onClick={() => open(a.id, a.title)}>
                      <span className="sm-ai-artifact-chip-icon" aria-hidden="true">{icon}</span>
                      {a.title}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {m.role === "assistant" && m.guardrail ? (
              <span className="sm-ai-guardrail-tag">Otto guides, doesn't do it for you</span>
            ) : null}
            {m.role === "assistant" && (() => {
              const mismatches = arithmeticMismatches(m.text);
              return mismatches.length ? (
                <div className="sm-ai-calc-check" role="note">
                  <span className="sm-ai-calc-check-icon" aria-hidden="true">⚠</span>
                  <span>
                    {L("Vérifie ce calcul avec Otto : ", "Double-check this with Otto: ")}
                    <code>{mismatches[0].raw}</code>
                    {(mismatches[0].actual != null && mismatches[0].claimed != null) ? ` (${mismatches[0].lhs} = ${mismatches[0].actual})` : ""}
                    {mismatches.length > 1 ? L(` — et ${mismatches.length - 1} autre(s)`, ` — and ${mismatches.length - 1} more`) : ""}
                  </span>
                </div>
              ) : null;
            })()}
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

      {diagnostics}
      {inputRow}
    </div>
  );
}
