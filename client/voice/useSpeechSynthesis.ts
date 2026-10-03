import { useCallback, useEffect, useRef, useState } from "react";

/** Strip the markdown Otto's replies use (headings, bold/italic emphasis markers, [links](url), GFM table
 *  pipes, bullet markers) down to plain readable prose — read aloud verbatim, "hashtag hashtag" and literal
 *  pipe/asterisk characters would be nonsense. Deliberately a small standalone pass rather than reusing
 *  renderChatText/renderNoteBody (client/ui.tsx) — those build React trees for on-screen display, this only
 *  ever needs a flat string for TTS, so duplicating the handful of regexes here is simpler than threading a
 *  "give me plain text instead of JSX" mode through the existing renderers. */
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

/** Split into sentence-sized chunks so `cancel()` (the barge-in "interrupt" gesture) actually stops
 *  promptly — one giant SpeechSynthesisUtterance for a whole multi-paragraph reply can't be interrupted
 *  mid-sentence on some browsers, it just keeps talking until that single utterance ends. */
function toSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : (text.trim() ? [text.trim()] : []);
}

export interface UseSpeechSynthesis {
  supported: boolean;
  speaking: boolean;
  speak: (text: string) => void;
  cancel: () => void;
  /** Call this from INSIDE a real click handler (never from an effect/async callback) before the first
   *  ever speak() of a session — e.g. the mic toggle's onClick. Browsers' autoplay policy allows an
   *  `<audio>` element to play without a fresh user gesture for the rest of the page's life ONCE one has
   *  successfully played during an actual gesture — but Otto's own replies always arrive asynchronously
   *  (a network round-trip, then TTS fetch), never inside the click that triggered them, so the very FIRST
   *  reply of a session could get silently blocked by the browser (NotAllowedError) with nothing visibly
   *  different about it — "TTS just doesn't work sometimes" was this, specifically on the first turn. */
  unlock: () => void;
  /** Human-readable trace of what the LAST speak() attempt actually did — which path it used and, when it
   *  failed, why. Surfaced in Settings' "Test the speaker" row: repeated rounds of "the speaker doesn't
   *  work" were impossible to act on because every distinct failure (missing server API key, CSP blocking
   *  blob: audio, no installed voices, autoplay policy) looked identical from the outside — silence. */
  lastDiagnostic: string | null;
}

/** Text-to-speech via the browser's own built-in `speechSynthesis` — every major browser (Chrome, Edge,
 *  Safari, Firefox) ships this with voices for both French and English pre-installed by the OS, so
 *  `lang` ("fr-FR" or "en-US", passed in by the caller based on the app's own language toggle) just works
 *  without any extra setup. See `speak()`'s own comment for why this is the ONLY path now — a third-party
 *  TTS vendor (FreeTTS) used to be tried first and this was the fallback; that was flipped after repeated
 *  live reports of "TTS sometimes works, sometimes doesn't" traced back to the vendor path's much larger
 *  failure surface (network call, API key, CSRF, CSP) — see git history on this file for that code if a
 *  nicer-sounding voice is ever worth re-introducing as a deliberate, carefully-raced opt-in upgrade. */
export function useSpeechSynthesis(lang: string): UseSpeechSynthesis {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [speaking, setSpeaking] = useState(false);
  const [lastDiagnostic, setLastDiagnostic] = useState<string | null>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const queueRef = useRef<string[]>([]);
  // A generation counter, not a shared boolean (the OLD cancelledRef design) — the boolean had a real,
  // confirmed race: a NEW speak() call reset it to false (to un-cancel for the new session) BEFORE the
  // PREVIOUS utterance's async onend/onerror had actually fired. That stale handler then read the just-
  // reset "false" and called speakNext() itself, racing the new session's own deferred speakNext() call
  // and consuming/corrupting the new queue — reported live as "sometimes TTS stops working," specifically
  // whenever a new reply arrived while the previous one was still mid-queue (the common case, not an edge
  // case). Each speak()/cancel() call now bumps this counter and captures the value at call time; every
  // handler (onend/onerror/watchdog) closes over that captured value and checks it against the CURRENT
  // counter before acting — a stale handler from a superseded session can never affect the new one, no
  // matter when its async callback actually fires.
  const genRef = useRef(0);

  useEffect(() => {
    if (!supported) return;
    const load = () => { voicesRef.current = window.speechSynthesis.getVoices(); };
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  }, [supported]);

  // Prefer an actually-good-sounding voice over whatever the browser defaults to (often a dated local
  // "espeak"-quality voice) — score by: exact language match beats base-language-only match; a named
  // network/cloud voice (Chrome's "Google …", Edge/Safari's "Natural"/"Enhanced"/"Premium" voices) beats a
  // generic local one; `localService === false` (network-backed, generally higher fidelity) is a tiebreaker.
  const pickVoice = useCallback((): SpeechSynthesisVoice | undefined => {
    const voices = voicesRef.current;
    const base = lang.slice(0, 2).toLowerCase();
    const score = (v: SpeechSynthesisVoice): number => {
      let s = 0;
      const vLang = v.lang.toLowerCase();
      if (vLang === lang.toLowerCase()) s += 8;
      else if (vLang.startsWith(base)) s += 4;
      else return -1; // wrong language entirely — never usable regardless of quality
      if (/google|natural|enhanced|premium|neural/i.test(v.name)) s += 3;
      if (!v.localService) s += 1;
      return s;
    };
    return voices
      .map((v) => ({ v, s: score(v) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)[0]?.v;
  }, [lang]);

  const speakNext = useCallback((gen: number) => {
    if (genRef.current !== gen) return; // superseded by a newer speak()/cancel() — never act on a stale session
    const next = queueRef.current.shift();
    if (!next) { setSpeaking(false); return; }
    const utter = new SpeechSynthesisUtterance(next);
    const voice = pickVoice();
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang; // match the voice's own reported lang exactly, not our requested one
    } else {
      // No installed voice matches `lang` at all (e.g. no French voice pack on an English-OS machine) —
      // setting utter.lang to an unmatched value is a known SILENT failure mode on some engines (no
      // onstart/onend/onerror, nothing ever plays, no error either). Leaving `lang` unset lets the engine
      // fall back to its own default voice instead of refusing to speak — a reply in the wrong accent
      // still beats total silence.
      console.warn(`[tts] no installed voice matches "${lang}" — using the browser's default voice instead`);
    }
    // A hair faster than the 1.0 default reads as more natural/conversational for short spoken replies —
    // browser TTS at exactly 1.0 tends to sound slightly plodding.
    utter.rate = 1.05;
    // Known Chrome bug: speechSynthesis.speak() silently does nothing for a chunk — no onstart, no onend,
    // no onerror, the browser just drops it — most often right after a cancel(), or after the tab/engine
    // has sat idle a while. Without a watchdog that chunk (and everything queued after it) goes mute
    // forever. BUT a first cut of this watchdog (plain "no onstart within 400ms = dropped") was ITSELF a
    // regression, reported live as "now it's not speaking to answer at all": `onstart` isn't guaranteed by
    // every voice even when speech genuinely is about to play — a remote/cloud voice in particular can take
    // longer than 400ms to actually begin, and firing early there means skipping queued content that was
    // never actually stuck, just slow. Ask the engine itself before concluding it's dropped: if
    // `speechSynthesis.speaking`/`.pending` still shows activity, this chunk is still legitimately in
    // flight — keep waiting, not skip. Only advance when the engine agrees nothing is happening at all.
    let started = false;
    const checkWatchdog = () => {
      if (started || genRef.current !== gen) return;
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) { watchdog = setTimeout(checkWatchdog, 400); return; }
      console.warn("[tts] browser speechSynthesis silently dropped a chunk, skipping it:", next.slice(0, 60));
      speakNext(gen);
    };
    let watchdog = setTimeout(checkWatchdog, 400);
    utter.onstart = () => { started = true; clearTimeout(watchdog); };
    utter.onend = () => { started = true; clearTimeout(watchdog); if (genRef.current === gen) speakNext(gen); };
    utter.onerror = () => { started = true; clearTimeout(watchdog); if (genRef.current === gen) speakNext(gen); };
    window.speechSynthesis.speak(utter);
  }, [lang, pickVoice]);

  const useBrowserTTS = useCallback((text: string) => {
    if (!supported) { console.error("[tts] FINAL FALLBACK FAILED: this browser has no speechSynthesis at all — nothing can be spoken."); setLastDiagnostic("This browser has no speech synthesis at all."); return; }
    const sentences = toSentences(toSpeakableText(text));
    if (!sentences.length) { console.error("[tts] FINAL FALLBACK FAILED: nothing speakable left after stripping markdown.", text.slice(0, 80)); setLastDiagnostic("The reply had nothing speakable in it."); return; }
    if (!voicesRef.current.length) {
      // getVoices() is populated asynchronously — an early call (before `onvoiceschanged`) legitimately
      // sees an empty list. Re-read it here rather than trusting the possibly-too-early load in the effect.
      voicesRef.current = window.speechSynthesis.getVoices();
      if (!voicesRef.current.length) { console.warn("[tts] the browser reports ZERO installed voices — speech may silently do nothing."); setLastDiagnostic("Browser speech is being used, but this device reports no installed voices."); }
    }
    // Devtools-only, not setLastDiagnostic: this fires on every single NORMAL successful speak, not just a
    // fallback/failure — surfacing it as a user-visible note (sm-ai-tts-note's whole point is explaining a
    // failure/fallback, see its own comment at the render site) turned the happy path into constant noise
    // ("Using this browser's built-in speech...") instead of only speaking up when something's actually
    // wrong. Reported live as unwanted.
    console.info(`[tts] speaking via browser speechSynthesis (${sentences.length} chunk(s), ${voicesRef.current.length} voices available)`);
    // Bump FIRST, before cancel() — this is what makes any in-flight PREVIOUS utterance's eventual async
    // onend/onerror a no-op (it captured the old generation number, which no longer matches genRef.current)
    // instead of racing this new session's own speakNext() call. See genRef's own doc comment above.
    const gen = ++genRef.current;
    window.speechSynthesis.cancel();
    queueRef.current = sentences;
    setSpeaking(true);
    // A speak() landing in the same tick as the cancel() above is another known Chrome race — the engine is
    // still tearing down the previous (possibly empty) queue and drops the new speak() silently. A tiny
    // deferral lets that teardown actually finish first.
    setTimeout(() => { if (genRef.current === gen) speakNext(gen); }, 30);
  }, [supported, speakNext]);

  const speak = useCallback((text: string) => {
    if (!supported) { console.warn("[tts] speak() called but speechSynthesis isn't supported in this browser"); setLastDiagnostic("This browser doesn't support speech at all."); return; }
    const speakableText = toSpeakableText(text);
    if (!speakableText.trim()) { console.warn("[tts] speak() called but the reply had nothing speakable after stripping markdown:", text.slice(0, 60)); setLastDiagnostic("That reply had nothing speakable in it."); return; }
    useBrowserTTS(speakableText);
  }, [supported, useBrowserTTS]);

  const cancel = useCallback(() => {
    if (!supported) return;
    genRef.current++; // invalidate any in-flight session so its stale handlers become no-ops
    queueRef.current = [];
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  // See this hook's own interface doc on `unlock` for why this exists: speechSynthesis.speak() can be
  // silently blocked by a browser's autoplay/gesture policy on the very FIRST call of a page's life if
  // that call doesn't happen inside a real user gesture — and Otto's replies always arrive async (a
  // network round trip), never inside the click that triggered them. An empty, silent utterance spoken
  // directly inside a click handler "unlocks" the engine for every subsequent speak() call that session,
  // same mechanism browsers use to unlock <audio>/<video> autoplay on first interaction.
  const unlock = useCallback(() => {
    if (!supported) return;
    try {
      // A non-empty string, not "" — an EMPTY utterance is a known browser trigger for the speech queue
      // getting stuck (no onend ever fires for it), which would silently block every REAL utterance queued
      // after it. Cancel right after speak(): what unlocks the engine is the synchronous speak() CALL
      // happening inside this real click handler, not the utterance actually finishing — immediately
      // clearing the queue afterward means this warm-up can never itself become the stuck thing.
      const warm = new SpeechSynthesisUtterance(" ");
      warm.volume = 0;
      window.speechSynthesis.speak(warm);
      window.speechSynthesis.cancel();
    } catch { /* best-effort — a failure here just means speak() might need a retry later, not fatal */ }
  }, [supported]);

  useEffect(() => () => cancel(), [cancel]);

  return { supported, speaking, speak, cancel, unlock, lastDiagnostic };
}
