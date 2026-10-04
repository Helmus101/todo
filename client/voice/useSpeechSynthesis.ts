import { useCallback, useEffect, useRef, useState } from "react";

/** Strip the markdown Otto's replies use (headings, bold/italic emphasis markers, [links](url), GFM table
 *  pipes, bullet markers) down to plain readable prose — read aloud verbatim, "hashtag hashtag" and literal
 *  pipe/asterisk characters would be nonsense. */
function toSpeakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")                 // code blocks — not worth reading aloud
    .replace(/`([^`]+)`/g, "$1")                      // inline code
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")                // headings
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")         // [label](url) → label
    .replace(/\*\*([^*]+)\*\*/g, "$1")                 // **bold**
    .replace(/\*([^*]+)\*/g, "$1")                     // *italic*
    .replace(/^\s{0,3}[-*+]\s+/gm, "")                 // bullet markers
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")               // numbered list markers
    .replace(/\|/g, ", ")                              // table pipes → a pause, not a literal bar
    .replace(/^\s{0,3}:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*$/gm, "") // table separator rows
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Sentence-sized chunks: cancel() stops promptly between chunks, and short utterances stay well under
 *  the ~15s length at which some engines silently stop mid-utterance. */
function toSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : (text.trim() ? [text.trim()] : []);
}

/** Rank voices for `lang`. ON-DEVICE voices first, always: Chrome's "Google …" voices are network
 *  voices (localService === false) — they fail silently, cut out after ~15s and don't work offline. The
 *  previous ranking gave those a BONUS, which made the least reliable voices the default. Exported for
 *  unit tests. Wrong-language voices are never returned. */
export function rankVoices<V extends { lang: string; name: string; localService: boolean; voiceURI: string }>(voices: V[], lang: string, exclude: Set<string> = new Set()): V[] {
  const want = lang.toLowerCase();
  const base = want.slice(0, 2);
  const score = (v: V): number => {
    const vLang = v.lang.toLowerCase().replace("_", "-");
    let s: number;
    if (vLang === want) s = 8;
    else if (vLang.startsWith(base)) s = 4;
    else return -1;
    if (v.localService) s += 10;
    if (/enhanced|premium|natural|neural/i.test(v.name)) s += 2;
    return s;
  };
  return voices
    .filter((v) => !exclude.has(v.voiceURI))
    .map((v) => ({ v, s: score(v) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.v);
}

export interface UseSpeechSynthesis {
  supported: boolean;
  speaking: boolean;
  speak: (text: string) => void;
  cancel: () => void;
  /** Call from INSIDE a real click handler (the mic toggle turning voice ON) so the first speak() of the
   *  session — which always arrives async, after a network round trip — isn't blocked by autoplay policy. */
  unlock: () => void;
  /** Set ONLY when speech genuinely failed (never on a normal success), shown as a muted note while
   *  voice mode is on. */
  lastDiagnostic: string | null;
}

type QueueItem = { text: string; retried: boolean };

// How long a chunk may take to START before we treat it as dropped. On-device voices start in well under
// a second; this is generous on purpose so a slow engine isn't skipped.
const START_TIMEOUT_MS = 4000;
// Ceiling for one chunk once it HAS started (no onend ever arriving is a real engine bug). Scales with
// length; ~70ms/char at rate 1.05 is comfortably slower than real speech.
const runTimeoutMs = (text: string) => Math.max(6000, text.length * 90);

/** Text-to-speech via the browser's own speechSynthesis (no network, no API key, French + English voices
 *  ship with every OS).
 *
 *  Invariants this implementation guarantees:
 *  - `speaking` can never get stuck true: every chunk ends via onend, onerror, or a timeout.
 *  - A failing voice can't silently eat a reply: a failed chunk is retried once with the next-best voice
 *    (the failing one is excluded for the rest of the session); a second failure is surfaced in
 *    lastDiagnostic instead of vanishing.
 *  - Stale callbacks can't touch a newer reply: every speak()/cancel() bumps `genRef`, and every handler
 *    checks the generation it was created with before doing anything.
 *  - The engine is never left paused: speak() resumes it if needed. */
export function useSpeechSynthesis(lang: string): UseSpeechSynthesis {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance !== "undefined";
  const [speaking, setSpeaking] = useState(false);
  const [lastDiagnostic, setLastDiagnostic] = useState<string | null>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const badVoicesRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<QueueItem[]>([]);
  const genRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const langRef = useRef(lang);
  langRef.current = lang;

  const fr = () => langRef.current.toLowerCase().startsWith("fr");
  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };

  useEffect(() => {
    if (!supported) return;
    const load = () => { voicesRef.current = window.speechSynthesis.getVoices(); };
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => { window.speechSynthesis.removeEventListener?.("voiceschanged", load); };
  }, [supported]);

  const speakNext = useCallback((gen: number) => {
    if (genRef.current !== gen) return;
    clearTimer();
    const engine = window.speechSynthesis;
    const item = queueRef.current.shift();
    if (!item) { setSpeaking(false); return; }

    if (!voicesRef.current.length) voicesRef.current = engine.getVoices();
    const voice = rankVoices(voicesRef.current, langRef.current, badVoicesRef.current)[0];
    const utter = new SpeechSynthesisUtterance(item.text);
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    } else if (!voicesRef.current.length) {
      // Voice list not loaded yet — let the engine pick its own voice for this language.
      utter.lang = langRef.current;
    }
    // Voices loaded but none matches the language: leave lang unset. Setting an unmatched lang is a
    // known silent failure on some engines; the default voice in the wrong accent beats silence.
    utter.rate = 1.05;

    let settled = false;
    const settle = (failed: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimer();
      if (genRef.current !== gen) return;
      if (failed) {
        console.warn(`[tts] chunk failed (${reason}) with voice "${voice?.name ?? "default"}":`, item.text.slice(0, 60));
        if (voice) badVoicesRef.current.add(voice.voiceURI);
        if (!item.retried) {
          queueRef.current.unshift({ text: item.text, retried: true });
        } else {
          setLastDiagnostic(fr()
            ? `La synthèse vocale a échoué (${reason}). Vérifie la sortie audio de ton appareil.`
            : `Speech playback failed (${reason}). Check your device's sound output.`);
        }
        // A stuck/failed utterance may still be holding the engine — reset it before the next attempt.
        try { if (engine.speaking || engine.pending) engine.cancel(); } catch { /* best-effort */ }
      }
      // Small gap after a failure: a speak() right after cancel() is a known silent drop in Chrome.
      timerRef.current = setTimeout(() => speakNext(gen), failed ? 80 : 0);
    };

    utter.onstart = () => {
      if (genRef.current !== gen) return;
      clearTimer();
      timerRef.current = setTimeout(() => {
        // Started but onend never arrived — the engine wedged. It has spoken most/all of it; move on.
        console.warn("[tts] chunk never reported its end, moving on:", item.text.slice(0, 60));
        try { engine.cancel(); } catch { /* best-effort */ }
        settle(false, "timeout");
      }, runTimeoutMs(item.text));
    };
    utter.onend = () => settle(false, "end");
    utter.onerror = (e: SpeechSynthesisErrorEvent) => settle(true, e?.error || "error");

    // Never started at all within START_TIMEOUT_MS → dropped (a real Chrome failure mode).
    timerRef.current = setTimeout(() => settle(true, "never-started"), START_TIMEOUT_MS);
    try {
      if (engine.paused) engine.resume();
      engine.speak(utter);
    } catch (err: any) {
      settle(true, err?.message || "speak-threw");
    }
  }, []);

  const speak = useCallback((text: string) => {
    if (!supported) {
      setLastDiagnostic(fr() ? "Ce navigateur ne gère pas la synthèse vocale." : "This browser doesn't support speech.");
      return;
    }
    const sentences = toSentences(toSpeakableText(text));
    if (!sentences.length) return;
    const engine = window.speechSynthesis;
    const gen = ++genRef.current;
    clearTimer();
    const wasBusy = engine.speaking || engine.pending;
    try { if (wasBusy) engine.cancel(); } catch { /* best-effort */ }
    try { if (engine.paused) engine.resume(); } catch { /* best-effort */ }
    queueRef.current = sentences.map((s) => ({ text: s, retried: false }));
    setLastDiagnostic(null);
    setSpeaking(true);
    console.info(`[tts] speaking ${sentences.length} chunk(s)`);
    // Only defer when we just cancelled something — that's the case where Chrome drops an immediate speak().
    if (wasBusy) timerRef.current = setTimeout(() => speakNext(gen), 60);
    else speakNext(gen);
  }, [supported, speakNext]);

  const cancel = useCallback(() => {
    if (!supported) return;
    genRef.current++;
    clearTimer();
    queueRef.current = [];
    try {
      const engine = window.speechSynthesis;
      if (engine.speaking || engine.pending) engine.cancel();
    } catch { /* best-effort */ }
    setSpeaking(false);
  }, [supported]);

  const unlock = useCallback(() => {
    if (!supported) return;
    const engine = window.speechSynthesis;
    // Something is already playing → the engine is clearly unlocked; touching it would only interrupt.
    if (engine.speaking || engine.pending) return;
    try {
      if (engine.paused) engine.resume();
      // Non-empty (an EMPTY utterance can wedge the queue), silent, cancelled straight away: what unlocks
      // the engine is the synchronous speak() call inside a real click, not the utterance finishing.
      const warm = new SpeechSynthesisUtterance(" ");
      warm.volume = 0;
      engine.speak(warm);
      engine.cancel();
    } catch { /* best-effort */ }
  }, [supported]);

  useEffect(() => () => cancel(), [cancel]);

  return { supported, speaking, speak, cancel, unlock, lastDiagnostic };
}
