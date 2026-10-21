import { getLanguage } from "../../language.ts";
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
  // OpenAI Realtime (WebRTC): the browser carries the audio itself, so there is no PCM plumbing on this side.
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const oaiStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const providerRef = useRef<"gemini" | "openai">("gemini");

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
    try { dcRef.current?.close(); } catch { /* */ } dcRef.current = null;
    try { pcRef.current?.close(); } catch { /* */ } pcRef.current = null;
    oaiStreamRef.current?.getTracks().forEach((t) => t.stop()); oaiStreamRef.current = null;
    if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current.srcObject = null; audioElRef.current = null; }
    setSpeaking(false); setMutedState(false); setBlocked(false);
    setStatus(next);
  }, [flush]);

  const stop = useCallback(() => teardown("ended"), [teardown]);

  const start = useCallback(async () => {
    if (aliveRef.current) return;
    aliveRef.current = true;
    setError(null); setStatus("connecting");
    let player = new Player(setSpeaking);
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
      const [{ GoogleGenAI, Modality }, tok] = await Promise.all([import("@google/genai"), api.liveToken({ lang: getLanguage(), subject: o.subject, pastSessions: o.pastSessions, resuming: o.resuming })]);
      if (!aliveRef.current) return;
      // Each provider is a function that either gets a live call going or throws (cleaning up after itself); they are tried in order below.
      type Cred = { token: string; model: string; models?: string[]; instructions: string };
      const tryOpenAI = async (tok: Cred) => {
        providerRef.current = "openai";
        player.close(); playerRef.current = null;
        const pc = new RTCPeerConnection();
        pcRef.current = pc;
        const audio = new Audio(); audio.autoplay = true; audioElRef.current = audio;
        pc.ontrack = (e) => { audio.srcObject = e.streams[0]; void audio.play().catch(() => setBlocked(true)); };
        const ms = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (!aliveRef.current) { ms.getTracks().forEach((t) => t.stop()); return; }
        oaiStreamRef.current = ms;
        pc.addTrack(ms.getAudioTracks()[0], ms);
        const dc = pc.createDataChannel("oai-events");
        dcRef.current = dc;
        const handleOai = (ev: any) => {
          if (!aliveRef.current) return;
          switch (ev.type) {
            case "conversation.item.input_audio_transcription.completed": youRef.current += (youRef.current ? " " : "") + String(ev.transcript || "").trim(); optsRef.current.onPartial?.(youRef.current, ottoRef.current); break;
            case "response.output_audio_transcript.delta": ottoRef.current += String(ev.delta || ""); optsRef.current.onPartial?.(youRef.current, ottoRef.current); break;
            case "output_audio_buffer.started": setSpeaking(true); break;
            case "output_audio_buffer.stopped": case "output_audio_buffer.cleared": setSpeaking(false); break;
            case "input_audio_buffer.speech_started": flush(); break;
            case "response.done": flush(); optsRef.current.onTurnComplete(); break;
            default: break;
          }
        };
        dc.onmessage = (e) => { try { handleOai(JSON.parse(e.data)); } catch { /* not ours */ } };
        dc.onopen = () => {
          // The model speaks first: a plain text turn, then ask for a response.
          dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "(Session started. Greet me briefly.)" }] } }));
          dc.send(JSON.stringify({ type: "response.create" }));
        };
        pc.onconnectionstatechange = () => { if (aliveRef.current && ["failed", "closed", "disconnected"].includes(pc.connectionState)) teardown("ended"); };
        await pc.setLocalDescription(await pc.createOffer());
        const r = await fetch("https://api.openai.com/v1/realtime/calls", { method: "POST", body: pc.localDescription?.sdp, headers: { Authorization: `Bearer ${tok.token}`, "Content-Type": "application/sdp" } });
        if (!r.ok) throw Object.assign(new Error(`The voice service refused the call (${r.status}).`), { status: 503 });
        await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
        if (!aliveRef.current) return;
        setStatus("live");
      };
      const tryGemini = async (tok: Cred) => {
      providerRef.current = "gemini";
      if (!playerRef.current) { player = new Player(setSpeaking); player.unlock(); playerRef.current = player; }
      const ai = new GoogleGenAI({ apiKey: tok.token, httpOptions: { apiVersion: "v1alpha" } });
      const config = {
        responseModalities: [Modality.AUDIO],
        systemInstruction: tok.instructions,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
      } as any;
      // Try the model ids in order: Google renames its live models often, so one that is refused (not found / not supported) just moves on.
      let session: any = null; const modelErrs: string[] = [];
      for (const model of tok.models?.length ? tok.models : [tok.model]) {
        if (!aliveRef.current) return;
        try {
          session = await new Promise<any>((resolve, reject) => {
            let opened: any = null, connecting: Promise<any> | null = null, settled = false;
            const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
            const timer = setTimeout(() => done(() => { try { opened?.close(); } catch { /* */ } reject(new Error("timeout")); }), 10_000);
            connecting = ai.live.connect({
              model, config,
              callbacks: {
                onopen: () => {},
                onmessage: (msg: any) => { if (msg.setupComplete && !settled) { done(() => { (connecting ?? Promise.resolve(opened)).then(resolve, reject); }); return; } if (settled) handle(msg); },
                onerror: (e: any) => { if (!settled) done(() => reject(new Error(String(e?.message || "error")))); else if (aliveRef.current) { setError(String(e?.message || "The voice connection failed.")); teardown("ended"); } },
                onclose: (e: any) => { if (!settled) done(() => reject(new Error(String(e?.reason || "closed")))); else if (aliveRef.current) { if (e?.code && e.code !== 1000) setError(String(e?.reason || "The voice connection closed.")); teardown("ended"); } },
              },
            });
            connecting.then((sess: any) => { opened = sess; }, (e: any) => done(() => reject(e)));
          });
          break;
        } catch (e: any) { modelErrs.push(`${model}: ${String(e?.message || e).slice(0, 110)}`); session = null; }
      }
      if (!session) throw Object.assign(new Error(modelErrs.join("; ") || "no model accepted the call"), { status: 503 });
      if (!aliveRef.current) { try { session.close(); } catch { /* */ } return; }
      sessionRef.current = session;
      const mic = await startMic((b64) => { try { sessionRef.current?.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } }); } catch { /* socket closing */ } });
      // The call may have been ended while the microphone was still starting: then the microphone must not stay open.
      if (!aliveRef.current) { mic.stop(); try { session.close(); } catch { /* */ } return; }
      micRef.current = mic;
      setStatus("live");
      window.setTimeout(() => { if (aliveRef.current && player.state !== "running") setBlocked(true); }, 800);
      // The model speaks first: nudge it so it greets from what it knows.
      session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "(Session started. Greet me briefly.)" }] }], turnComplete: true });
      };
      // Gemini first; if it cannot connect (or isn't configured), OpenAI takes over. The server sends a credential for each provider it has a key for.
      const creds = (tok.providers?.length ? tok.providers : [tok]) as Array<Cred & { provider?: string }>;
      let lastFailure: any = null;
      const failures: string[] = [];
      for (const c of creds) {
        if (!aliveRef.current) return;
        try { if (c.provider === "openai") await tryOpenAI(c); else await tryGemini(c); lastFailure = null; break; }
        catch (e: any) {
          lastFailure = e;
          failures.push(`${c.provider === "openai" ? "OpenAI" : "Gemini"}: ${String(e?.message || e).replace(/^Error:\s*/, "").slice(0, 160)}`);
          // clean up what the failed attempt left behind, then try the next provider (a blocked microphone is the same for all of them)
          try { dcRef.current?.close(); } catch { /* */ } dcRef.current = null;
          try { pcRef.current?.close(); } catch { /* */ } pcRef.current = null;
          oaiStreamRef.current?.getTracks().forEach((t) => t.stop()); oaiStreamRef.current = null;
          try { sessionRef.current?.close(); } catch { /* */ } sessionRef.current = null;
          micRef.current?.stop(); micRef.current = null;
          if (/NotAllowed|Permission|denied/i.test(String(e?.name || e?.message))) break;
        }
      }
      if (lastFailure) throw Object.assign(new Error(failures.join(" · ")), { status: lastFailure?.status ?? 503, name: lastFailure?.name, failures });
    } catch (e: any) {
      const denied = /NotAllowed|Permission|denied/i.test(String(e?.name || e?.message));
      const unavailable = e?.status === 503 || e?.status === 502 || e?.status === 429 || e?.status === 403 || denied;
      setError(e?.status === 429 ? String(e?.message || "Live voice limit reached for today.") : denied ? "Microphone blocked — allow it for this site and try again." : e?.status === 503 && /set up/i.test(String(e?.message)) ? "Live voice isn't set up on this server (no Gemini or OpenAI key)." : `Live voice couldn't connect. ${String(e?.message || "").replace(/^Error:\s*/, "").slice(0, 280)}`.trim());
      teardown(unavailable ? "unavailable" : "ended");
    }
  }, [teardown, flush]);

  const setMuted = useCallback((m: boolean) => { micRef.current?.setMuted(m); oaiStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !m; }); setMutedState(m); }, []);
  /** A picture of the student's drawing, as a video frame: the voice sees it and answers when they next speak. */
  const sendImage = useCallback((dataUrl: string) => {
    if (providerRef.current === "openai") {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== "open") return false;
      try { dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "(My drawing on the board right now.)" }, { type: "input_image", image_url: dataUrl }] } })); return true; } catch { return false; }
    }
    const s = sessionRef.current;
    const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl);
    if (!s || !m) return false;
    try { s.sendRealtimeInput({ video: { data: m[2], mimeType: m[1] } }); return true; } catch { return false; }
  }, []);
  /** Something the student TYPED while the call is open: the voice answers it out loud. */
  const sendText = useCallback((text: string) => {
    if (providerRef.current === "openai") {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== "open" || !text.trim()) return false;
      try {
        dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
        dc.send(JSON.stringify({ type: "response.create" }));
        return true;
      } catch { return false; }
    }
    const s = sessionRef.current;
    if (!s || !text.trim()) return false;
    try { s.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true }); youRef.current += ""; return true; } catch { return false; }
  }, []);
  /** The play button: one tap lets the browser play Otto's voice. */
  const resumePlayback = useCallback(() => { playerRef.current?.unlock(); void audioElRef.current?.play().catch(() => {}); setBlocked(false); }, []);

  useEffect(() => () => { if (aliveRef.current) teardown("ended"); }, [teardown]);
  return { status, error, speaking, muted, blocked, start, stop, setMuted, sendImage, sendText, resumePlayback };
}
