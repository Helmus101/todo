import { useCallback, useEffect, useRef, useState } from "react";
import { speechErrorMessage } from "./speechErrors.ts";

// The Web Speech API's SpeechRecognition isn't in TS's default DOM lib (it's still non-standard,
// webkit-prefixed in most browsers) — declare just the surface this hook actually uses rather than pulling
// in a whole ambient-types package for one interface.
interface SpeechRecognitionResultLike { isFinal: boolean; length?: number; [index: number]: { transcript: string } | undefined; 0: { transcript: string } }
interface SpeechRecognitionEventLike { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> }
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

export interface UseSpeechRecognitionOptions {
  lang: string;
  /** Fires once per detected utterance (the browser's own voice-activity endpointing — a natural pause in
   *  speech — marks a result `isFinal`), not once per start()/stop() cycle. In continuous/always-on mode
   *  this can fire many times across one long-running listen session. Never fires with empty/whitespace text. */
  onResult: (transcript: string, meta?: { alternatives: string[] }) => void;
  /** Fires on EVERY recognition event with the live, not-yet-final text ("" between utterances) — the
   *  barge-in channel. Final results only arrive after the browser's pause detection, which is far too
   *  late to interrupt a sentence mid-word; interim text streams in word by word while the utterance is
   *  still being spoken, so a caller watching THIS can cancel TTS the instant real student speech is
   *  detected. Purely advisory — not firing it changes nothing else. */
  onInterim?: (text: string) => void;
  /** Fires with a bilingual [fr, en] message whenever recognition genuinely fails (mic permission denied,
   *  no microphone, network down, unsupported language) — the hook itself only surfaces the RAW codes and
   *  they used to vanish silently, leaving a mic pill that lights up and hears nothing. `no-speech` and
   *  `aborted` never fire this: they're normal events in always-on mode, not failures. */
  onError?: (message: [string, string]) => void;
}

export interface UseSpeechRecognition {
  supported: boolean;
  listening: boolean;
  /** Live, not-yet-final text while listening — for showing "hearing you..." feedback in the UI. */
  interimTranscript: string;
  /** Starts listening and KEEPS listening across multiple utterances/pauses — this is the "always on" mic:
   *  it does not stop after one sentence. Call `stop()`/`abort()` to actually turn it off. If the underlying
   *  recognizer ends on its own (some browsers cap a single session at ~60s, or drop it on a network blip),
   *  it's transparently restarted as long as nothing called stop()/abort() in the meantime. */
  start: () => void;
  stop: () => void;
  abort: () => void;
}

/** Always-on speech-to-text via the browser's free, built-in Web Speech API — no server round trip, no paid
 *  STT vendor. Feature-detects: `supported` is false on browsers with no SpeechRecognition (Firefox, most
 *  notably) so callers can hide voice UI entirely rather than show a mic button that silently does nothing. */
export function useSpeechRecognition({ lang, onResult, onInterim, onError }: UseSpeechRecognitionOptions): UseSpeechRecognition {
  const Ctor = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : undefined;
  const supported = !!Ctor;
  const [listening, setListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onInterimRef = useRef(onInterim);
  onInterimRef.current = onInterim;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // Set true for the duration of an intended listening session (from start() to stop()/abort()) — onend
  // checks this to decide "the browser dropped the session on its own, restart it" vs "the user/app actually
  // wanted this to stop." Without this distinction, mic-always-on mode would silently go dead the moment
  // Chrome's own session cap or a transient network hiccup ended the underlying recognizer.
  const keepAliveRef = useRef(false);
  // Reported live: a short mid-thought breath ("so the derivative of x squared... is 2x") was getting cut
  // into two separate sent messages — the browser's own pause-detection marks a result `isFinal` on any
  // brief silence, which is far shorter than a natural thinking pause. Don't act on a final result the
  // instant it lands: buffer it and wait a bit for more speech. If nothing more arrives, flush as one
  // message; if another final (or renewed interim activity) arrives first, append to the SAME buffer and
  // restart the wait — so one real pause mid-utterance joins into one message instead of firing early.
  const pendingFinalRef = useRef("");
  // The recognizer's runner-up readings of the buffered utterance (maxAlternatives), one full-text variant
  // per alternative segment. Speech recognition mishears maths constantly ("tan 25" → "10 25", "adjacent"
  // → "json"); the runner-up is often the right one, so the tutor gets to see it too.
  const pendingAltsRef = useRef<string[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushPending = useCallback(() => {
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    const text = pendingFinalRef.current.trim();
    const alternatives = pendingAltsRef.current.map((a) => a.trim()).filter((a) => a && a !== text).slice(0, 3);
    pendingFinalRef.current = "";
    pendingAltsRef.current = [];
    if (text) onResultRef.current(text, { alternatives });
  }, []);
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(flushPending, 900);
  }, [flushPending]);

  const createAndStart = useCallback(() => {
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;      // don't stop after one utterance — this IS the always-on behavior
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    rec.onresult = (e) => {
      let interim = "";
      // Each `isFinal` result is ONE complete utterance per the browser's own pause detection — fire
      // onResult immediately per utterance rather than accumulating across the whole session, so a long
      // always-on listen produces one message per natural turn instead of one giant run-on block.
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) {
            const before = pendingFinalRef.current;
            // Earlier alternatives get this segment appended; this segment's own alternatives get the earlier text.
            pendingAltsRef.current = pendingAltsRef.current.map((a) => `${a} ${text}`);
            for (let k = 1; k < Math.min(r.length ?? 1, 3); k++) {
              const alt = r[k]?.transcript?.trim();
              if (alt && alt !== text) pendingAltsRef.current.push(before ? `${before} ${alt}` : alt);
            }
            pendingFinalRef.current = before ? `${before} ${text}` : text;
            scheduleFlush();
          }
        } else {
          interim += r[0].transcript;
        }
      }
      setInterimTranscript(interim);
      // Live interim text out (barge-in channel) — trimmed, and "" when nothing is pending so callers
      // can treat empty as "no speech in flight".
      onInterimRef.current?.(interim.trim());
      // Fresh speech arriving while a final result is still buffered (mid-thought, they kept going before
      // the flush timer fired) extends the wait — otherwise the buffered half could still flush out from
      // under them right as they resume talking.
      if (interim.trim() && pendingFinalRef.current) scheduleFlush();
    };
    rec.onerror = (e) => {
      // "no-speech" fires constantly in always-on mode (every silent gap) — not a real error, just Chrome's
      // way of saying "nothing detected in this stretch." Let onend's restart logic handle it; don't tear
      // down listening state over it. "aborted" is our own stop()/abort() — likewise normal.
      if (e.error === "no-speech" || e.error === "aborted") return;
      // A genuinely fatal error (mic permission denied, no microphone plugged in) DOES stop listening for
      // real — restarting would just fail again forever. Everything real ALSO reports a student-presentable
      // bilingual message now: these used to be swallowed whole, so a blocked mic looked identical to
      // "listening, heard nothing" and the student had no way to know what was wrong.
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
        keepAliveRef.current = false;
        setListening(false);
      }
      onErrorRef.current?.(speechErrorMessage(e.error));
    };
    rec.onend = () => {
      // STALE-INSTANCE GUARD: onend fires ASYNCHRONOUSLY (per spec), so it can land well after this exact
      // `rec` has already been superseded — e.g. the user toggles voice mode off then back on again quickly
      // ("clicking it a second time"): off calls abort() on this instance, which schedules onend for later;
      // on immediately creates a NEW rec and sets keepAliveRef back to true before that old onend ever
      // fires. Without this check, the OLD instance's onend sees keepAliveRef===true (set by the NEW
      // session, not this one) and "helpfully" restarts AGAIN — a second createAndStart() racing the one
      // the user's second click already triggered, fighting over the mic/producing a session that "doesn't
      // open normally". Only the CURRENT instance (recRef.current still === this rec) is allowed to act;
      // a superseded one's onend is a no-op.
      if (recRef.current !== rec) return;
      setInterimTranscript("");
      onInterimRef.current?.("");
      if (keepAliveRef.current) {
        // Reported live: the student got cut off mid-sentence "sometimes" — not from a real pause, but
        // from the browser's OWN session cap (most engines force a session to end after ~60s even in
        // continuous mode) landing mid-utterance. The old code flushed the pending buffer unconditionally
        // right here, before restarting — which sent a half-finished thought out as a message purely
        // because of where the 60s boundary happened to fall, nothing the student did. Don't flush: the
        // buffer (and its already-scheduled flush timer, if one is pending) is a ref, so it simply survives
        // the restart below and keeps accumulating once the new recognizer's onresult starts firing again —
        // the student never notices the session underneath them was replaced.
        setTimeout(() => { if (keepAliveRef.current && recRef.current === rec) createAndStartRef.current?.(); }, 50);
      } else {
        flushPending(); // a REAL stop (stop()/abort() or a fatal error) — send what was still buffered rather than losing it
        setListening(false);
      }
    };
    recRef.current = rec;
    // start() is synchronous and can THROW (InvalidStateError) if the browser's native recognizer is still
    // mid-teardown from a just-prior session — a real, known Web Speech API quirk, and a likely cause of
    // "sometimes pressing the mic button doesn't work": this component starts/stops recognition rapidly
    // around TTS playback (pause the mic while Otto is talking, resume right after — see the effect a few
    // hundred lines down in TaskCard.tsx), so back-to-back start() calls landing before the previous
    // session has actually finished tearing down is not an edge case here, it's routine. Uncaught, this left
    // `listening` stuck at true (set below, optimistically, before this call) while the mic was actually
    // dead — the UI claiming to listen while capturing nothing, with no way to recover except toggling voice
    // mode off and on again. Catch it, revert the optimistic state, and retry once after a short delay
    // (long enough for the browser's teardown to actually finish) before giving up for real.
    try {
      setListening(true);
      rec.start();
    } catch {
      setListening(false);
      if (keepAliveRef.current) {
        setTimeout(() => { if (keepAliveRef.current) createAndStartRef.current?.(); }, 150);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Ctor, lang]);
  // createAndStart recreates itself via a stable ref so onend's restart-on-drop can always call the LATEST
  // version (closing over current `lang`) without needing to be listed as an onend dependency.
  const createAndStartRef = useRef(createAndStart);
  createAndStartRef.current = createAndStart;

  const start = useCallback(() => {
    if (!Ctor || keepAliveRef.current) return;
    keepAliveRef.current = true;
    createAndStart();
  }, [Ctor, createAndStart]);

  const stop = useCallback(() => {
    keepAliveRef.current = false;
    recRef.current?.stop();
  }, []);

  const abort = useCallback(() => {
    keepAliveRef.current = false;
    recRef.current?.abort();
    setListening(false);
    setInterimTranscript("");
    // Discard, don't flush — abort() is an intentional "stop hearing me now" (voice mode off, barge-in
    // cancelling Otto), and the async onend this triggers must not resurrect a half-said utterance after
    // the fact. Clear the timer directly rather than via flushPending, which would send it.
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    pendingFinalRef.current = "";
  }, []);

  useEffect(() => () => abort(), [abort]);

  // Switching languages mid-session (e.g. the account's FR/EN preference changes while voice mode is
  // already on) previously had no effect on an ALREADY-RUNNING recognizer — `rec.lang` is only ever read
  // once, at construction (see createAndStart above), so the old language kept being recognized silently
  // until the student manually toggled voice mode off and back on. Restart transparently whenever `lang`
  // changes while actively listening; the stale-instance guard on onend (see its own comment) already makes
  // this abort-then-immediately-restart sequence safe — the old instance's delayed onend is a no-op once
  // recRef.current has moved on to the new one. Skipped on the very first render (isFirstRef) — the initial
  // start() call already picks up whatever `lang` is current, nothing to restart yet.
  const isFirstLangRef = useRef(true);
  useEffect(() => {
    if (isFirstLangRef.current) { isFirstLangRef.current = false; return; }
    if (!keepAliveRef.current) return; // not currently listening — the next start() will just use the new lang
    recRef.current?.abort();
    createAndStartRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  return { supported, listening, interimTranscript, start, stop, abort };
}
