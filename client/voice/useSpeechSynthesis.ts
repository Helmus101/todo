import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";

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
  /** Human-readable trace of what the LAST speak() attempt actually did — which path it used and, when it
   *  failed, why. Surfaced in Settings' "Test the speaker" row: repeated rounds of "the speaker doesn't
   *  work" were impossible to act on because every distinct failure (missing server API key, CSP blocking
   *  blob: audio, no installed voices, autoplay policy) looked identical from the outside — silence. */
  lastDiagnostic: string | null;
}

/** Text-to-speech via FreeTTS (freetts.org) if available, falling back to the browser's built-in
 *  `speechSynthesis`. FreeTTS uses the "brian" voice for natural speech; the browser fallback picks a
 *  matching voice by language (fr-FR/en-US, matching the app's own language toggle). */
export function useSpeechSynthesis(lang: string): UseSpeechSynthesis {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [speaking, setSpeaking] = useState(false);
  const [lastDiagnostic, setLastDiagnostic] = useState<string | null>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const queueRef = useRef<string[]>([]);
  const cancelledRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Barge-in generation counter: FreeTTS is an async fetch-then-play pipeline, and the old cancel() only
  // paused an ALREADY-PLAYING audio element — a cancel() landing while the /api/tts fetch was still in
  // flight (or before play() resolved) was silently ignored: the fetch resolved anyway, play() started,
  // onplay flipped speaking back to true, and Otto kept talking AFTER being interrupted (plus the flag
  // could stay true forever if play() settled late — the voice loop wedged waiting for speech that never
  // ends). Each speak() bumps the generation; an async continuation checks it before speaking and before
  // flipping state, so anything still resolving from a pre-cancel speak() becomes a no-op.
  const generationRef = useRef(0);

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

  const speakNext = useCallback(() => {
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
      if (started || cancelledRef.current) return;
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) { watchdog = setTimeout(checkWatchdog, 400); return; }
      console.warn("[tts] browser speechSynthesis silently dropped a chunk, skipping it:", next.slice(0, 60));
      speakNext();
    };
    let watchdog = setTimeout(checkWatchdog, 400);
    utter.onstart = () => { started = true; clearTimeout(watchdog); };
    utter.onend = () => { started = true; clearTimeout(watchdog); if (!cancelledRef.current) speakNext(); };
    utter.onerror = () => { started = true; clearTimeout(watchdog); if (!cancelledRef.current) speakNext(); };
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
    console.info(`[tts] speaking via browser speechSynthesis (${sentences.length} chunk(s), ${voicesRef.current.length} voices available)`);
    if (voicesRef.current.length) setLastDiagnostic(`Using this browser's built-in speech (${voicesRef.current.length} voices available).`);
    cancelledRef.current = false;
    window.speechSynthesis.cancel();
    queueRef.current = sentences;
    setSpeaking(true);
    // A speak() landing in the same tick as the cancel() above is another known Chrome race — the engine is
    // still tearing down the previous (possibly empty) queue and drops the new speak() silently. A tiny
    // deferral lets that teardown actually finish first.
    setTimeout(() => { if (!cancelledRef.current) speakNext(); }, 30);
  }, [supported, speakNext]);

  const speakViaFreeTTS = useCallback(async (text: string, myGeneration: number) => {
    // ONE-SHOT fallback guard. A blocked/failed audio element fires BOTH `audio.onerror` AND rejects the
    // `audio.play()` promise — so the old code called useBrowserTTS twice for one failure, and the second
    // call's `speechSynthesis.cancel()` tore down the utterance the first call had just started. Two
    // fallbacks racing each other produced silence, which is precisely the "it still doesn't work" symptom
    // left over after the CSP fix below. Whichever failure signal lands first wins; the rest are no-ops.
    let fellBack = false;
    const fallBack = (why: string, detail?: unknown) => {
      if (fellBack || generationRef.current !== myGeneration) return;
      fellBack = true;
      console.warn(`[tts] FreeTTS path unavailable (${why}) — falling back to the browser's own speechSynthesis.`, detail ?? "");
      setLastDiagnostic(`Otto's own voice is unavailable (${why}); using the browser's built-in speech instead.`);
      useBrowserTTS(text);
    };
    try {
      // Goes through client/api.ts's req(), NOT a bare fetch — that's what attaches the x-csrf-token
      // header every other mutating POST in the app needs. A bare fetch here (an earlier bug) 403'd on
      // every single call in production, always silently falling back to browser TTS.
      console.info(`[tts] requesting FreeTTS audio (${text.length} chars, lang=${lang})`);
      const response = await api.ttsAudio(text, lang.slice(0, 2).toLowerCase());
      // The barge-in cancel() landed while this fetch was in flight — this utterance is dead, don't
      // speak it and DON'T fall back to browser TTS (that would undo the interruption).
      if (generationRef.current !== myGeneration) return;
      if (!response.ok) {
        // 501 = FREETTS_API_KEY isn't configured on the server (very common: the key lives in a local .env
        // that was never added to the production environment); 403 = CSRF; 500 = the vendor itself failed.
        const detail = await response.text().catch(() => "");
        fallBack(`/api/tts returned HTTP ${response.status}`, detail.slice(0, 200));
        return;
      }
      const blob = await response.blob();
      if (!blob.size) { fallBack("/api/tts returned an empty audio body"); return; }
      const url = URL.createObjectURL(blob);
      if (audioRef.current) URL.revokeObjectURL(audioRef.current.src);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onplay = () => { if (generationRef.current === myGeneration) { console.info("[tts] FreeTTS audio playing"); setLastDiagnostic("Working — playing Otto's own voice."); setSpeaking(true); } };
      audio.onended = () => { if (generationRef.current === myGeneration) { setSpeaking(false); URL.revokeObjectURL(url); } };
      audio.onerror = () => {
        if (generationRef.current !== myGeneration) return;
        setSpeaking(false);
        URL.revokeObjectURL(url);
        // The classic cause here is a Content-Security-Policy with no `media-src` allowing `blob:` — the
        // element is blocked before a single byte is decoded, with no other symptom. See vercel.json.
        fallBack("the <audio> element errored (CSP media-src blocking blob:? corrupt audio?)", audio.error);
      };
      await audio.play();
    } catch (e) {
      // Network drop, a rejected play() (Chrome's autoplay policy → NotAllowedError), or a CSP block.
      // Logged, never silent: a blocked autoplay, a 501 from /api/tts, and a network failure used to look
      // identical to the student (silence), with nothing anywhere saying which one it actually was.
      fallBack(e instanceof Error ? `${e.name}: ${e.message}` : "unknown error", e);
    }
  }, [useBrowserTTS, lang]);

  const speak = useCallback((text: string) => {
    if (!supported) { console.warn("[tts] speak() called but speechSynthesis isn't supported in this browser"); setLastDiagnostic("This browser doesn't support speech at all."); return; }
    const speakableText = toSpeakableText(text);
    if (!speakableText.trim()) { console.warn("[tts] speak() called but the reply had nothing speakable after stripping markdown:", text.slice(0, 60)); setLastDiagnostic("That reply had nothing speakable in it."); return; }
    cancelledRef.current = false;
    // New utterance = new generation: invalidates any pre-cancel async continuation still in flight.
    const myGeneration = ++generationRef.current;
    // Try FreeTTS first, fallback to browser TTS
    void speakViaFreeTTS(speakableText, myGeneration);
  }, [supported, speakViaFreeTTS]);

  const cancel = useCallback(() => {
    if (!supported) return;
    cancelledRef.current = true;
    // Bump the generation FIRST: every in-flight /api/tts fetch and pending play() from the current
    // utterance becomes a no-op the moment it resolves, so an interruption mid-fetch actually stays
    // interrupted instead of the speech starting over the student's head.
    generationRef.current++;
    queueRef.current = [];
    window.speechSynthesis.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      if (audioRef.current.src) URL.revokeObjectURL(audioRef.current.src);
      audioRef.current = null;
    }
    setSpeaking(false);
  }, [supported]);

  useEffect(() => () => cancel(), [cancel]);

  return { supported, speaking, speak, cancel, lastDiagnostic };
}
