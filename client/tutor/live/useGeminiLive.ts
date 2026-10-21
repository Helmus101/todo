import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api.ts";
import { startMic, Player, type Mic } from "./audio.ts";

export type LiveStatus = "idle" | "connecting" | "live" | "ended" | "unavailable";

export interface LiveOptions {
  subject?: string;
  /** What Otto's server uses to build the memory the voice starts with (earlier sessions kept on this device). */
  pastSessions?: { when: string; subject?: string; lines: string[]; asked: string[] }[];
  resuming?: boolean;
  /** One finished utterance: what the student said, or what Otto said (from Gemini's own transcription). */
  onTurn: (who: "you" | "otto", text: string) => void;
  /** Otto finished speaking: time for the board writer. */
  onTurnComplete: () => void;
  /** The words so far, for the live caption. */
  onPartial?: (you: string, otto: string) => void;
}

/** One live conversation with Gemini Live. The voice model IS the tutor (instructions and memory come from the server with the token);
 *  the board is written separately after each exchange. A failure to start ends quietly with status "unavailable" so the caller can
 *  fall back to the classic voice. */
export function useGeminiLive(opts: LiveOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [blocked, setBlocked] = useState(false); // the browser is holding the sound back until the student taps (Safari, or no earlier click on the page)
  const sessionRef = useRef<any>(null);
  const micRef = useRef<Mic | null>(null);
  const playerRef = useRef<Player | null>(null);
  const youRef = useRef("");
  const ottoRef = useRef("");
  const aliveRef = useRef(false);

  const flush = useCallback(() => {
    const you = youRef.current.trim(), otto = ottoRef.current.trim();
    youRef.current = ""; ottoRef.current = "";
    if (you) optsRef.current.onTurn("you", you);
    if (otto) optsRef.current.onTurn("otto", otto);
    optsRef.current.onPartial?.("", "");
  }, []);

  const teardown = useCallback((next: LiveStatus) => {
    const wasAlive = aliveRef.current;
    aliveRef.current = false;
    if (wasAlive) flush();
    try { sessionRef.current?.close(); } catch { /* already closed */ }
    sessionRef.current = null;
    micRef.current?.stop(); micRef.current = null;
    playerRef.current?.close(); playerRef.current = null;
    setSpeaking(false); setMutedState(false); setBlocked(false);
    setStatus(next);
  }, [flush]);

  const stop = useCallback(() => teardown("ended"), [teardown]);

  const start = useCallback(async () => {
    if (aliveRef.current) return;
    aliveRef.current = true;
    setError(null); setStatus("connecting");
    const player = new Player(setSpeaking);
    player.unlock(); // inside the click when there was one
    playerRef.current = player;
    const handle = (msg: any) => {
      if (!aliveRef.current) return;
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.interrupted) { player.interrupt(); flush(); }
      if (sc.inputTranscription?.text) youRef.current += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) ottoRef.current += sc.outputTranscription.text;
      if (sc.inputTranscription?.text || sc.outputTranscription?.text) optsRef.current.onPartial?.(youRef.current, ottoRef.current);
      for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data) { player.push(p.inlineData.data); if (player.state === "suspended") setBlocked(true); }
      if (sc.turnComplete) { flush(); optsRef.current.onTurnComplete(); }
    };
    try {
      const o = optsRef.current;
      const [{ GoogleGenAI, Modality }, tok] = await Promise.all([import("@google/genai"), api.liveToken({ subject: o.subject, pastSessions: o.pastSessions, resuming: o.resuming })]);
      if (!aliveRef.current) return;
      const ai = new GoogleGenAI({ apiKey: tok.token, httpOptions: { apiVersion: "v1alpha" } });
      const config = {
        responseModalities: [Modality.AUDIO],
        systemInstruction: tok.instructions,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
      } as any;
      // Try the model ids in order: Google renames its live models often, so one that is refused (not found / not supported) just moves on.
      let session: any = null, lastErr = "";
      for (const model of tok.models?.length ? tok.models : [tok.model]) {
        if (!aliveRef.current) return;
        try {
          session = await new Promise<any>((resolve, reject) => {
            let opened: any = null, settled = false;
            const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
            const timer = setTimeout(() => done(() => { try { opened?.close(); } catch { /* */ } reject(new Error("timeout")); }), 10_000);
            ai.live.connect({
              model, config,
              callbacks: {
                onopen: () => {},
                onmessage: (msg: any) => { if (msg.setupComplete && !settled) { done(() => resolve(opened)); return; } if (settled) handle(msg); },
                onerror: (e: any) => { if (!settled) done(() => reject(new Error(String(e?.message || "error")))); else if (aliveRef.current) { setError(String(e?.message || "The voice connection failed.")); teardown("ended"); } },
                onclose: (e: any) => { if (!settled) done(() => reject(new Error(String(e?.reason || "closed")))); else if (aliveRef.current) { if (e?.code && e.code !== 1000) setError(String(e?.reason || "The voice connection closed.")); teardown("ended"); } },
              },
            }).then((sess: any) => { opened = sess; }, (e: any) => done(() => reject(e)));
          });
          break;
        } catch (e: any) { lastErr = String(e?.message || e); session = null; }
      }
      if (!session) throw Object.assign(new Error(lastErr || "Live voice isn't available right now."), { status: 503 });
      if (!aliveRef.current) { try { session.close(); } catch { /* */ } return; }
      sessionRef.current = session;
      micRef.current = await startMic((b64) => { try { sessionRef.current?.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } }); } catch { /* socket closing */ } });
      setStatus("live");
      window.setTimeout(() => { if (aliveRef.current && player.state !== "running") setBlocked(true); }, 800);
      // The model speaks first: nudge it so it greets from what it knows.
      session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "(Session started. Greet me briefly.)" }] }], turnComplete: true });
    } catch (e: any) {
      const denied = /NotAllowed|Permission|denied/i.test(String(e?.name || e?.message));
      const unavailable = e?.status === 503 || e?.status === 502 || e?.status === 429 || e?.status === 403 || denied;
      setError(e?.status === 429 ? String(e?.message || "Live voice limit reached for today.") : denied ? "Microphone blocked — allow it for this site and try again." : e?.status === 503 && /set up/i.test(String(e?.message)) ? "Live voice isn't set up on this server (no Gemini key)." : "Live voice isn't available right now.");
      teardown(unavailable ? "unavailable" : "ended");
    }
  }, [teardown, flush]);

  const setMuted = useCallback((m: boolean) => { micRef.current?.setMuted(m); setMutedState(m); }, []);
  /** A picture of the student's drawing, as a video frame: the voice sees it and answers when they next speak. */
  const sendImage = useCallback((dataUrl: string) => {
    const s = sessionRef.current;
    const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl);
    if (!s || !m) return false;
    try { s.sendRealtimeInput({ video: { data: m[2], mimeType: m[1] } }); return true; } catch { return false; }
  }, []);
  /** Something the student TYPED while the call is open: the voice answers it out loud. */
  const sendText = useCallback((text: string) => {
    const s = sessionRef.current;
    if (!s || !text.trim()) return false;
    try { s.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true }); youRef.current += ""; return true; } catch { return false; }
  }, []);
  /** The play button: one tap lets the browser play Otto's voice. */
  const resumePlayback = useCallback(() => { playerRef.current?.unlock(); setBlocked(false); }, []);

  useEffect(() => () => { if (aliveRef.current) teardown("ended"); }, [teardown]);
  return { status, error, speaking, muted, blocked, start, stop, setMuted, sendImage, sendText, resumePlayback };
}
