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
}

/** Text-to-speech via the browser's free, built-in `speechSynthesis` — no server round trip, no paid TTS
 *  vendor. `lang` picks a matching installed voice (fr-FR/en-US, matching the app's own language toggle) —
 *  falls back to the browser default voice if none matches (still speaks, just not guaranteed accent). */
export function useSpeechSynthesis(lang: string): UseSpeechSynthesis {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [speaking, setSpeaking] = useState(false);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const queueRef = useRef<string[]>([]);
  const cancelledRef = useRef(false);

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
    utter.lang = lang;
    const voice = pickVoice();
    if (voice) utter.voice = voice;
    // A hair faster than the 1.0 default reads as more natural/conversational for short spoken replies —
    // browser TTS at exactly 1.0 tends to sound slightly plodding.
    utter.rate = 1.05;
    utter.onend = () => { if (!cancelledRef.current) speakNext(); };
    utter.onerror = () => { if (!cancelledRef.current) speakNext(); };
    window.speechSynthesis.speak(utter);
  }, [lang, pickVoice]);

  const speak = useCallback((text: string) => {
    if (!supported) return;
    const sentences = toSentences(toSpeakableText(text));
    if (!sentences.length) return;
    cancelledRef.current = false;
    window.speechSynthesis.cancel(); // clear anything already queued/speaking before starting fresh
    queueRef.current = sentences;
    setSpeaking(true);
    speakNext();
  }, [supported, speakNext]);

  const cancel = useCallback(() => {
    if (!supported) return;
    cancelledRef.current = true;
    queueRef.current = [];
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  useEffect(() => () => cancel(), [cancel]);

  return { supported, speaking, speak, cancel };
}
