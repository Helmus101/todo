import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";

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
 *  the ~15s length at which some browser engines silently stop mid-utterance. */
function toSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : (text.trim() ? [text.trim()] : []);
}

// Reported live: Gemini's TTS preview model has a small per-minute request quota, and the old "first
// sentence alone, then the rest" splitting below sent 2 API calls per reply — roughly double the quota
// burn for no real benefit once a 429 actually hit (the whole point of splitting was a faster-feeling
// start, which doesn't matter if the request gets rate-limited instead). One call per reply now; only a
// genuinely long reply (approaching the model's own request-size comfort zone) still splits, and even then
// into as FEW chunks as possible rather than many small ones.
const CLOUD_CHUNK_MAX_CHARS = 1800;
/** Group sentences into as few chunks as possible (fewer requests = less quota burn), each ≤
 *  CLOUD_CHUNK_MAX_CHARS. Joined text is also what makes the neural voice sound fluid — splitting on every
 *  sentence resets the model's intonation at each period. Exported for unit tests. */
export function cloudChunks(sentences: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && `${cur} ${s}`.length > CLOUD_CHUNK_MAX_CHARS) { out.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/** Rank browser voices for `lang` (used only by the browser fallback). ON-DEVICE voices first: Chrome's
 *  "Google …" voices are network voices that fail silently and cut out after ~15s. Wrong-language voices
 *  are never returned. Exported for unit tests. */
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

/** ~20ms of silence as a WAV data URI — played inside the mic-toggle click to unlock the <audio> element
 *  for later, non-gesture playback (Safari unlocks per element; Chrome per page). */
function silentWavDataUri(): string {
  const samples = 480, bytes = new Uint8Array(44 + samples * 2);
  const dv = new DataView(bytes.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); dv.setUint32(4, 36 + samples * 2, true); w(8, "WAVE"); w(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 24000, true); dv.setUint32(28, 48000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, samples * 2, true);
  let bin = ""; bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return `data:audio/wav;base64,${btoa(bin)}`;
}

export interface UseSpeechSynthesis {
  supported: boolean;
  speaking: boolean;
  speak: (text: string) => void;
  cancel: () => void;
  /** Call from INSIDE a real click handler (the mic toggle turning voice ON) so the first reply — which
   *  always arrives async, after a network round trip — isn't blocked by autoplay policy. */
  unlock: () => void;
  /** Set ONLY when speech genuinely failed everywhere (never on a normal success). */
  lastDiagnostic: string | null;
}

type QueueItem = { text: string; retried: boolean };

const CLOUD_FETCH_TIMEOUT_MS = 8000;    // slower than this → speak with the browser voice instead
const START_TIMEOUT_MS = 4000;          // browser engine: a chunk that never starts is treated as dropped
const runTimeoutMs = (text: string) => Math.max(8000, text.length * 110); // ceiling for one chunk once playing

/** The tutor's voice, via one endpoint (/api/tts) that itself tries two free, keyless providers server-
 *  side — Gemini's neural voice first, then Amazon Polly (via StreamElements) if Gemini's small preview-
 *  model quota is hit (server/claude.ts's synthesizeSpeech/synthesizeSpeechFallback). Direct request: the
 *  browser's own speechSynthesis is never the primary experience — it only speaks if BOTH of those fail,
 *  time out, or the whole request is blocked from playing, which should be rare now that there are two
 *  independent cloud tiers instead of one.
 *
 *  Invariants:
 *  - `speaking` can never get stuck true: every chunk ends via an end event, an error, or a timeout.
 *  - Speech never silently disappears: a cloud failure falls through to the browser voice for the rest of
 *    the reply; a browser chunk that fails is retried once with another voice; only a failure of BOTH is
 *    surfaced (lastDiagnostic).
 *  - Stale work can't touch a newer reply: every speak()/cancel() bumps `genRef`, and every async step
 *    re-checks the generation it started with before doing anything.
 *  - A cloud voice that's down/unconfigured is skipped for the rest of the page session, so a dead service
 *    doesn't add a fetch delay before every reply. */
export function useSpeechSynthesis(lang: string): UseSpeechSynthesis {
  const synthSupported = typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance !== "undefined";
  const audioSupported = typeof window !== "undefined" && typeof window.Audio !== "undefined";
  const supported = synthSupported || audioSupported;
  const [speaking, setSpeaking] = useState(false);
  const [lastDiagnostic, setLastDiagnostic] = useState<string | null>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const badVoicesRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<QueueItem[]>([]);
  const genRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopPlaybackRef = useRef<(() => void) | null>(null);
  const urlsRef = useRef<string[]>([]);
  const cloudOffRef = useRef(false);     // permanent for this page session (not configured / repeated non-quota failures)
  const cloudBackoffUntilRef = useRef(0); // temporary — a 429 is quota, which resets on its own shortly
  const cloudFailsRef = useRef(0);
  const cloudBackoffMsRef = useRef(15_000);
  const langRef = useRef(lang);
  langRef.current = lang;

  const fr = () => langRef.current.toLowerCase().startsWith("fr");
  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
  const getAudio = () => (audioRef.current ||= new Audio());
  const releaseUrls = () => { urlsRef.current.forEach((u) => URL.revokeObjectURL(u)); urlsRef.current = []; };
  const stopAudio = () => {
    stopPlaybackRef.current?.();
    stopPlaybackRef.current = null;
    const a = audioRef.current;
    if (a) { a.onended = null; a.onerror = null; try { a.pause(); } catch { /* ignore */ } }
  };
  const failedEverywhere = (reason: string) => setLastDiagnostic(fr()
    ? `La synthèse vocale a échoué (${reason}). Vérifie la sortie audio de ton appareil.`
    : `Speech playback failed (${reason}). Check your device's sound output.`);

  useEffect(() => {
    if (!synthSupported) return;
    const load = () => { voicesRef.current = window.speechSynthesis.getVoices(); };
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => { window.speechSynthesis.removeEventListener?.("voiceschanged", load); };
  }, [synthSupported]);

  // ── Browser fallback engine ──────────────────────────────────────────────────────────────────────────
  const speakNext = useCallback((gen: number) => {
    if (genRef.current !== gen) return;
    clearTimer();
    const item = queueRef.current.shift();
    if (!item) { setSpeaking(false); return; }
    if (!synthSupported) { queueRef.current = []; setSpeaking(false); failedEverywhere("no-speech-engine"); return; }
    const engine = window.speechSynthesis;
    if (!voicesRef.current.length) voicesRef.current = engine.getVoices();
    const voice = rankVoices(voicesRef.current, langRef.current, badVoicesRef.current)[0];
    const utter = new SpeechSynthesisUtterance(item.text);
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    } else if (!voicesRef.current.length) {
      utter.lang = langRef.current; // voice list not loaded yet — let the engine pick for this language
    }
    // Voices loaded but none matches: leave lang unset (an unmatched lang is a known silent failure).
    utter.rate = 1.05;

    let settled = false;
    const settle = (failed: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimer();
      if (genRef.current !== gen) return;
      if (failed) {
        console.warn(`[tts] browser chunk failed (${reason}) with voice "${voice?.name ?? "default"}":`, item.text.slice(0, 60));
        if (voice) badVoicesRef.current.add(voice.voiceURI);
        if (!item.retried) queueRef.current.unshift({ text: item.text, retried: true });
        else failedEverywhere(reason);
        try { if (engine.speaking || engine.pending) engine.cancel(); } catch { /* best-effort */ }
      }
      timerRef.current = setTimeout(() => speakNext(gen), failed ? 80 : 0);
    };
    utter.onstart = () => {
      if (genRef.current !== gen) return;
      clearTimer();
      timerRef.current = setTimeout(() => {
        console.warn("[tts] browser chunk never reported its end, moving on:", item.text.slice(0, 60));
        try { engine.cancel(); } catch { /* best-effort */ }
        settle(false, "timeout");
      }, runTimeoutMs(item.text));
    };
    utter.onend = () => settle(false, "end");
    utter.onerror = (e: SpeechSynthesisErrorEvent) => settle(true, e?.error || "error");
    timerRef.current = setTimeout(() => settle(true, "never-started"), START_TIMEOUT_MS);
    try {
      if (engine.paused) engine.resume();
      engine.speak(utter);
    } catch (err: any) {
      settle(true, err?.message || "speak-threw");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synthSupported]);

  const speakWithBrowser = useCallback((gen: number, texts: string[]) => {
    if (genRef.current !== gen) return;
    queueRef.current = texts.flatMap((t) => toSentences(t)).map((t) => ({ text: t, retried: false }));
    if (synthSupported) {
      const engine = window.speechSynthesis;
      const wasBusy = engine.speaking || engine.pending;
      try { if (wasBusy) engine.cancel(); if (engine.paused) engine.resume(); } catch { /* best-effort */ }
      if (wasBusy) { timerRef.current = setTimeout(() => speakNext(gen), 60); return; }
    }
    speakNext(gen);
  }, [synthSupported, speakNext]);

  // ── Cloud voice (Gemini) ─────────────────────────────────────────────────────────────────────────────
  // Reported live: Gemini's TTS preview model has a small per-minute quota, hit during an ordinary back-
  // and-forth tutoring session. A 429 is quota, not an outage — it resets shortly, so it gets a short,
  // doubling backoff (15s, 30s, 60s, capped at 2min) instead of the permanent-for-the-session disable
  // other failures get. A genuinely dead/misconfigured service (501, or 2 NON-quota failures in a row)
  // still disables permanently so every later reply doesn't pay a fetch delay for nothing.
  const noteCloudFailure = (err: any) => {
    const status = err?.status;
    if (status === 429) {
      cloudBackoffUntilRef.current = Date.now() + cloudBackoffMsRef.current;
      cloudBackoffMsRef.current = Math.min(cloudBackoffMsRef.current * 2, 120_000);
      console.warn(`[tts] cloud voice rate-limited (429) — using the browser voice for ${Math.round(cloudBackoffMsRef.current / 2000)}s, then retrying the cloud voice`);
      return;
    }
    cloudFailsRef.current++;
    // 501 = not configured on this deployment; two non-quota failures in a row = something's actually
    // broken, not just a transient blip. Either way stop trying for this page session.
    if (status === 501 || cloudFailsRef.current >= 2) {
      cloudOffRef.current = true;
      console.warn(`[tts] cloud voice failed (${err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : status ?? err?.message ?? "error"}) — using the browser voice for the rest of this session`);
    } else {
      console.warn(`[tts] cloud voice failed (${status ?? err?.message ?? "error"}) — using the browser voice for this reply`);
    }
  };

  const fetchChunk = async (text: string): Promise<string> => {
    const r = await api.ttsAudio(text, langRef.current.slice(0, 2), AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS));
    if (!r.ok) { const e: any = new Error(`tts ${r.status}`); e.status = r.status; throw e; }
    const blob = await r.blob();
    if (!blob.size) throw new Error("empty audio");
    const url = URL.createObjectURL(blob);
    urlsRef.current.push(url);
    return url;
  };

  const playUrl = (url: string, text: string): Promise<void> => new Promise((resolve, reject) => {
    const a = getAudio();
    let done = false;
    const finish = (err?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(ceiling);
      a.onended = null; a.onerror = null;
      if (stopPlaybackRef.current === stopThis) stopPlaybackRef.current = null;
      if (err) reject(err); else resolve();
    };
    const stopThis = () => finish();
    stopPlaybackRef.current = stopThis;
    const ceiling = setTimeout(() => { try { a.pause(); } catch { /* ignore */ } finish(); }, runTimeoutMs(text));
    a.onended = () => finish();
    a.onerror = () => finish(new Error("audio element error"));
    a.src = url;
    a.play().catch((e) => finish(e));
  });

  const speakWithCloud = useCallback(async (gen: number, sentences: string[]) => {
    // Almost always ONE chunk now (see cloudChunks — fewer requests = less quota burn); fetched up front
    // so a multi-chunk reply's later chunks download while the first one plays.
    const chunks = cloudChunks(sentences);
    const pending = chunks.map((c) => fetchChunk(c));
    pending.forEach((p) => p.catch(() => { /* handled in order below */ }));
    for (let i = 0; i < chunks.length; i++) {
      let url: string;
      try { url = await pending[i]; }
      catch (e) { if (genRef.current !== gen) return; noteCloudFailure(e); speakWithBrowser(gen, chunks.slice(i)); return; }
      if (genRef.current !== gen) return;
      try { await playUrl(url, chunks[i]); cloudFailsRef.current = 0; cloudBackoffMsRef.current = 15_000; }
      catch (e) { if (genRef.current !== gen) return; noteCloudFailure(e); speakWithBrowser(gen, chunks.slice(i)); return; }
      if (genRef.current !== gen) return;
    }
    releaseUrls();
    setSpeaking(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakWithBrowser]);

  // ── Public API ───────────────────────────────────────────────────────────────────────────────────────
  const speak = useCallback((text: string) => {
    if (!supported) {
      setLastDiagnostic(fr() ? "Ce navigateur ne gère pas la synthèse vocale." : "This browser doesn't support speech.");
      return;
    }
    const sentences = toSentences(toSpeakableText(text));
    if (!sentences.length) return;
    const gen = ++genRef.current;
    clearTimer();
    stopAudio();
    releaseUrls();
    setLastDiagnostic(null);
    setSpeaking(true);
    const useCloud = audioSupported && !cloudOffRef.current && Date.now() >= cloudBackoffUntilRef.current;
    console.info(`[tts] speaking ${sentences.length} sentence(s) via ${useCloud ? "Gemini voice" : "browser voice"}`);
    if (useCloud) void speakWithCloud(gen, sentences);
    else speakWithBrowser(gen, sentences);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, audioSupported, speakWithCloud, speakWithBrowser]);

  const cancel = useCallback(() => {
    genRef.current++;
    clearTimer();
    queueRef.current = [];
    stopAudio();
    releaseUrls();
    if (synthSupported) {
      try { const engine = window.speechSynthesis; if (engine.speaking || engine.pending) engine.cancel(); } catch { /* best-effort */ }
    }
    setSpeaking(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synthSupported]);

  const unlock = useCallback(() => {
    // <audio>: play a blip of silence inside the click so later playback isn't blocked by autoplay policy.
    if (audioSupported) {
      const a = getAudio();
      if (a.paused) { try { a.src = silentWavDataUri(); void a.play().catch(() => { /* best-effort */ }); } catch { /* ignore */ } }
    }
    if (!synthSupported) return;
    const engine = window.speechSynthesis;
    if (engine.speaking || engine.pending) return; // already speaking → already unlocked; don't interrupt
    try {
      if (engine.paused) engine.resume();
      // Non-empty (an EMPTY utterance can wedge the queue), silent, cancelled straight away.
      const warm = new SpeechSynthesisUtterance(" ");
      warm.volume = 0;
      engine.speak(warm);
      engine.cancel();
    } catch { /* best-effort */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioSupported, synthSupported]);

  useEffect(() => () => cancel(), [cancel]);

  return { supported, speaking, speak, cancel, unlock, lastDiagnostic };
}
