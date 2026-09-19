import { useCallback, useEffect, useRef, useState } from "react";

// The Web Speech API's SpeechRecognition isn't in TS's default DOM lib (it's still non-standard,
// webkit-prefixed in most browsers) — declare just the surface this hook actually uses rather than pulling
// in a whole ambient-types package for one interface.
interface SpeechRecognitionResultLike { isFinal: boolean; 0: { transcript: string } }
interface SpeechRecognitionEventLike { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> }
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
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
  onResult: (transcript: string) => void;
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
export function useSpeechRecognition({ lang, onResult }: UseSpeechRecognitionOptions): UseSpeechRecognition {
  const Ctor = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : undefined;
  const supported = !!Ctor;
  const [listening, setListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  // Set true for the duration of an intended listening session (from start() to stop()/abort()) — onend
  // checks this to decide "the browser dropped the session on its own, restart it" vs "the user/app actually
  // wanted this to stop." Without this distinction, mic-always-on mode would silently go dead the moment
  // Chrome's own session cap or a transient network hiccup ended the underlying recognizer.
  const keepAliveRef = useRef(false);

  const createAndStart = useCallback(() => {
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;      // don't stop after one utterance — this IS the always-on behavior
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = "";
      // Each `isFinal` result is ONE complete utterance per the browser's own pause detection — fire
      // onResult immediately per utterance rather than accumulating across the whole session, so a long
      // always-on listen produces one message per natural turn instead of one giant run-on block.
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) onResultRef.current(text);
        } else {
          interim += r[0].transcript;
        }
      }
      setInterimTranscript(interim);
    };
    rec.onerror = (e) => {
      // "no-speech" fires constantly in always-on mode (every silent gap) — not a real error, just Chrome's
      // way of saying "nothing detected in this stretch." Let onend's restart logic handle it; don't tear
      // down listening state over it. A genuinely fatal error (e.g. "not-allowed" — mic permission denied)
      // DOES stop listening for real, since restarting would just fail again forever.
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        keepAliveRef.current = false;
        setListening(false);
      }
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
      if (keepAliveRef.current) {
        // The recognizer stopped on its own (session cap / blip) but the app still wants to be listening —
        // restart transparently. A brief microtask delay avoids some browsers' "already started" race when
        // onend and a fresh start() land in the same tick.
        setTimeout(() => { if (keepAliveRef.current && recRef.current === rec) createAndStartRef.current?.(); }, 50);
      } else {
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
  }, []);

  useEffect(() => () => abort(), [abort]);

  return { supported, listening, interimTranscript, start, stop, abort };
}
