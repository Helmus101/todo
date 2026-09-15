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
  /** false (default, v1/push-to-talk) = one utterance per start() call, auto-stops after `silenceMs` of
   *  no new speech. true = kept for the hands-free fast-follow (see the voice-mode plan) — not wired to any
   *  UI yet, but the hook already supports it so that mode is a config flip, not a rewrite. */
  continuous?: boolean;
  /** How long to wait after the last recognized word before treating the utterance as done and auto-
   *  stopping — this IS the "auto-sends after you stop talking" behavior, no second tap required. */
  silenceMs?: number;
  /** Fires once an utterance is considered complete (silence timeout, or manual stop()) with the final
   *  transcript text. Never fires with an empty/whitespace-only transcript. */
  onResult: (transcript: string) => void;
}

export interface UseSpeechRecognition {
  supported: boolean;
  listening: boolean;
  /** Live, not-yet-final text while listening — for showing "hearing you..." feedback in the UI. */
  interimTranscript: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

/** Push-to-talk (and, later, hands-free) speech-to-text via the browser's free, built-in Web Speech API —
 *  no server round trip, no paid STT vendor. Feature-detects: `supported` is false on browsers with no
 *  SpeechRecognition (Firefox, most notably) so callers can hide voice UI entirely rather than show a
 *  mic button that silently does nothing. */
export function useSpeechRecognition({ lang, continuous = false, silenceMs = 1200, onResult }: UseSpeechRecognitionOptions): UseSpeechRecognition {
  const Ctor = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : undefined;
  const supported = !!Ctor;
  const [listening, setListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const clearSilenceTimer = () => { if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; } };

  const stop = useCallback(() => {
    clearSilenceTimer();
    recRef.current?.stop();
  }, []);

  const abort = useCallback(() => {
    clearSilenceTimer();
    finalRef.current = "";
    recRef.current?.abort();
    setListening(false);
    setInterimTranscript("");
  }, []);

  const start = useCallback(() => {
    if (!Ctor || listening) return;
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = continuous;
    rec.interimResults = true;
    finalRef.current = "";
    setInterimTranscript("");
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalRef.current += r[0].transcript;
        else interim += r[0].transcript;
      }
      setInterimTranscript(interim);
      // Reset the silence-to-auto-stop timer on every new word — only fires once speech has genuinely
      // paused, not after a fixed delay from when listening started.
      clearSilenceTimer();
      silenceTimerRef.current = setTimeout(() => rec.stop(), silenceMs);
    };
    rec.onerror = () => { clearSilenceTimer(); setListening(false); };
    rec.onend = () => {
      clearSilenceTimer();
      setListening(false);
      setInterimTranscript("");
      const text = finalRef.current.trim();
      if (text) onResultRef.current(text);
    };
    recRef.current = rec;
    setListening(true);
    rec.start();
  }, [Ctor, lang, continuous, silenceMs, listening]);

  useEffect(() => () => abort(), [abort]);

  return { supported, listening, interimTranscript, start, stop, abort };
}
