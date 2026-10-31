import { getLanguage } from "../../language.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api.ts";
import { startMic, Player, type Mic } from "./audio.ts";

import { makeNoteTag } from "../../../shared/noteTag.ts";
import { completeSentences } from "../../../shared/liveTutor.ts";
import { BOARD_TOOL_GEMINI, BOARD_TOOL_NAME } from "../../../shared/boardTool.ts";
export const sessionNoteTag = makeNoteTag(); // per page load; the server puts it in the instructions
export type LiveStatus = "idle" | "connecting" | "live" | "ended" | "unavailable";

export interface LiveOptions {
  subject?: string;
  /** What Otto's server uses to build the memory the voice starts with (earlier sessions kept on this device). */
  pastSessions?: { when: string; subject?: string; lines: string[]; asked: string[] }[];
  resuming?: boolean;
  /** When resuming: the last turns of this session ("Student: …" / "Otto: …") so the voice picks up exactly where it stopped. */
  resumeTail?: string[];
  /** One finished utterance: what the student said, or what Otto said (from Gemini's own transcription). */
  onTurn: (who: "you" | "otto", text: string) => void;
  /** Otto finished speaking: time for the board writer. */
  onTurnComplete: () => void;
  /** The words so far, for the live caption. */
  onPartial?: (you: string, otto: string) => void;
  /** Otto's pen: the voice model called write_board. Resolves to what goes back to the model (what was written, refused, and the board). */
  onWriteBoard?: (args: any, said: { you: string; otto: string }) => Promise<unknown>;
  /** The call restarts in the middle of a sitting (a drop, the silence timeout): no greeting, pick up where it was. */
  quietResume?: boolean;
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
  const youLiveRef = useRef(""); // words of the sentence being spoken right now (OpenAI streams them before the sentence is final)
  const ottoRef = useRef("");
  const aliveRef = useRef(false);
  // OpenAI Realtime (WebRTC): the browser carries the audio itself, so there is no PCM plumbing on this side.
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const oaiStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const providerRef = useRef<"gemini" | "openai">("gemini");
  // Whether this call's model accepted the write_board tool. Without it the separate board writer writes everything, as before.
  const [toolMode, setToolMode] = useState(false);
  const oaiContinueRef = useRef(false); // a tool result went back during this OpenAI response: ask for the rest once it is done
  const runTool = useCallback(async (name: string, args: any): Promise<unknown> => {
    if (name !== BOARD_TOOL_NAME || !optsRef.current.onWriteBoard) return { error: "unknown tool" };
    try { return await optsRef.current.onWriteBoard(args, { you: youRef.current, otto: ottoRef.current }); }
    catch (e: any) { return { written: [], refused: [{ line: "", reason: "the board could not be reached just now; do not say it is on the board" }], board: "", error: String(e?.message || e).slice(0, 120) }; }
  }, []);
  // Only a fresh call speaks first; a reconnect waits for the student (see `quietResume` below).
  const greeting = () => "(Session started. Greet me briefly.)";

  const lastTurnRef = useRef<{ who: "you" | "otto"; text: string } | null>(null);
  // `cut`: the turn was interrupted (the student spoke over Otto, or the call dropped), so the last words are half a sentence — only the
  // sentences that were actually finished go into the transcript. A turn the model (or a reconnect) repeats word for word is shown once.
  const flush = useCallback((cut = false) => {
    const you = youRef.current.trim();
    const otto = cut ? completeSentences(ottoRef.current.trim()) : ottoRef.current.trim();
    youRef.current = ""; youLiveRef.current = ""; ottoRef.current = "";
    const emit = (who: "you" | "otto", text: string) => {
      const prev = lastTurnRef.current;
      if (who === "otto" && prev?.who === "otto" && prev.text === text) return;
      lastTurnRef.current = { who, text };
      optsRef.current.onTurn(who, text);
    };
    if (you) emit("you", you);
    if (otto) emit("otto", otto);
    optsRef.current.onPartial?.("", "");
  }, []);

  const liveSinceRef = useRef(0);
  const lastHeardRef = useRef(0); // the last time any words were heard, from the student or from Otto
  const teardown = useCallback((next: LiveStatus) => {
    const wasAlive = aliveRef.current;
    aliveRef.current = false;
    // How long the call lasted is metered against the weekly AI allowance.
    if (wasAlive && liveSinceRef.current) { const secs = Math.round((Date.now() - liveSinceRef.current) / 1000); liveSinceRef.current = 0; if (secs > 3) void api.reportVoiceSeconds(secs).catch(() => {}); }
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
      // Otto writes on the board: run each call and send the result back, so the voice knows what is on the paper.
      if (msg.toolCall?.functionCalls?.length) {
        for (const fc of msg.toolCall.functionCalls) void runTool(fc.name, fc.args).then((result) => { try { sessionRef.current?.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { result } }] }); } catch { /* socket closing */ } });
      }
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.inputTranscription?.text || sc.outputTranscription?.text || sc.modelTurn) lastHeardRef.current = Date.now();
      if (sc.interrupted) { player.interrupt(); flush(true); }
      if (sc.inputTranscription?.text) youRef.current += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) ottoRef.current += sc.outputTranscription.text;
      if (sc.inputTranscription?.text || sc.outputTranscription?.text) optsRef.current.onPartial?.(youRef.current, ottoRef.current);
      for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data) { player.push(p.inlineData.data); if (player.state === "suspended") setBlocked(true); }
      if (sc.turnComplete) { flush(); optsRef.current.onTurnComplete(); }
    };
    try {
      const o = optsRef.current;
      const [{ GoogleGenAI, Modality }, tok] = await Promise.all([import("@google/genai"), api.liveToken({ lang: getLanguage(), subject: o.subject, pastSessions: o.pastSessions, resuming: o.resuming, resumeTail: o.resumeTail, noteTag: sessionNoteTag })]);
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
            case "conversation.item.input_audio_transcription.delta": lastHeardRef.current = Date.now(); youLiveRef.current += String(ev.delta || ""); optsRef.current.onPartial?.(`${youRef.current ? youRef.current + " " : ""}${youLiveRef.current}`.trim(), ottoRef.current); break;
            case "conversation.item.input_audio_transcription.completed": youLiveRef.current = ""; lastHeardRef.current = Date.now(); youRef.current += (youRef.current ? " " : "") + String(ev.transcript || "").trim(); optsRef.current.onPartial?.(youRef.current, ottoRef.current); break;
            case "response.output_audio_transcript.delta": lastHeardRef.current = Date.now(); ottoRef.current += String(ev.delta || ""); optsRef.current.onPartial?.(youRef.current, ottoRef.current); break;
            case "output_audio_buffer.started": setSpeaking(true); break;
            case "output_audio_buffer.stopped": case "output_audio_buffer.cleared": setSpeaking(false); break;
            case "input_audio_buffer.speech_started": flush(true); break;
            case "response.function_call_arguments.done": {
              let args: any = {};
              try { args = JSON.parse(String(ev.arguments || "{}")); } catch { /* malformed: the tool answers with nothing written */ }
              void runTool(String(ev.name || ""), args).then((result) => {
                try { dcRef.current?.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(result) } })); oaiContinueRef.current = true; } catch { /* closing */ }
              });
              break;
            }
            case "response.done":
              flush(); optsRef.current.onTurnComplete();
              // The response ended on a board write: let Otto carry on speaking now that it knows what was written.
              if (oaiContinueRef.current) { oaiContinueRef.current = false; try { dcRef.current?.send(JSON.stringify({ type: "response.create" })); } catch { /* closing */ } }
              break;
            default: break;
          }
        };
        dc.onmessage = (e) => { try { handleOai(JSON.parse(e.data)); } catch { /* not ours */ } };
        dc.onopen = () => {
          // The model speaks first: a plain text turn, then ask for a response. NOT when the call is only picking up again:
          // an automatic "where we were" reply is one answer the student never asked for, and it repeats the question already asked.
          if (optsRef.current.quietResume) return;
          dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: greeting() }] } }));
          dc.send(JSON.stringify({ type: "response.create" }));
        };
        pc.onconnectionstatechange = () => { if (aliveRef.current && ["failed", "closed", "disconnected"].includes(pc.connectionState)) teardown("ended"); };
        await pc.setLocalDescription(await pc.createOffer());
        const r = await fetch("https://api.openai.com/v1/realtime/calls", { method: "POST", body: pc.localDescription?.sdp, headers: { Authorization: `Bearer ${tok.token}`, "Content-Type": "application/sdp" } });
        if (!r.ok) throw Object.assign(new Error(`The voice service refused the call (${r.status}).`), { status: 503 });
        await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
        if (!aliveRef.current) return;
        setToolMode(!!(tok as any).tools && !!optsRef.current.onWriteBoard);
        liveSinceRef.current = Date.now(); lastHeardRef.current = Date.now(); setStatus("live");
      };
      const tryGemini = async (tok: Cred) => {
      providerRef.current = "gemini";
      if (!playerRef.current) { player = new Player(setSpeaking); player.unlock(); playerRef.current = player; }
      const ai = new GoogleGenAI({ apiKey: tok.token, httpOptions: { apiVersion: "v1alpha" } });
      const baseConfig = {
        responseModalities: [Modality.AUDIO],
        systemInstruction: tok.instructions,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } },
      } as any;
      // Try the model ids in order: Google renames its live models often, so one that is refused (not found / not supported) just moves on.
      // Each model is tried with Otto's pen (the write_board tool) first; a model that refuses tools is tried again without, and the board writer then writes everything.
      let session: any = null; const modelErrs: string[] = []; let withTools = false;
      const attempts = (tok.models?.length ? tok.models : [tok.model]).flatMap((model) => (optsRef.current.onWriteBoard ? [{ model, tools: true }, { model, tools: false }] : [{ model, tools: false }]));
      for (const { model, tools } of attempts) {
        if (!aliveRef.current) return;
        const config = tools ? { ...baseConfig, tools: [{ functionDeclarations: [BOARD_TOOL_GEMINI] }] } : baseConfig;
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
          withTools = tools;
          break;
        } catch (e: any) { modelErrs.push(`${model}${tools ? " (with the board tool)" : ""}: ${String(e?.message || e).slice(0, 110)}`); session = null; }
      }
      if (!session) throw Object.assign(new Error(modelErrs.join("; ") || "no model accepted the call"), { status: 503 });
      if (!aliveRef.current) { try { session.close(); } catch { /* */ } return; }
      sessionRef.current = session;
      const mic = await startMic((b64) => { try { sessionRef.current?.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } }); } catch { /* socket closing */ } });
      // The call may have been ended while the microphone was still starting: then the microphone must not stay open.
      if (!aliveRef.current) { mic.stop(); try { session.close(); } catch { /* */ } return; }
      micRef.current = mic;
      setToolMode(withTools);
      liveSinceRef.current = Date.now(); lastHeardRef.current = Date.now(); setStatus("live");
      window.setTimeout(() => { if (aliveRef.current && player.state !== "running") setBlocked(true); }, 800);
      // The model speaks first: nudge it so it greets from what it knows. On a reconnect it stays quiet until the student does:
      // no automatic second reply that repeats what it already asked.
      if (!optsRef.current.quietResume) session.sendClientContent({ turns: [{ role: "user", parts: [{ text: greeting() }] }], turnComplete: true });
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
  }, [teardown, flush, runTool]);

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
  /** Something the student TYPED while the call is open: the voice answers it out loud. `reply: false` (private notes) only adds it to the
   *  conversation: Otto reads it with the student's next words instead of answering it on its own (which gave two replies to one message). */
  const sendText = useCallback((text: string, reply = true) => {
    if (providerRef.current === "openai") {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== "open" || !text.trim()) return false;
      if (reply) lastHeardRef.current = Date.now();
      try {
        dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
        if (reply) dc.send(JSON.stringify({ type: "response.create" }));
        return true;
      } catch { return false; }
    }
    const s = sessionRef.current;
    if (!s || !text.trim()) return false;
    try { if (reply) lastHeardRef.current = Date.now(); s.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: reply }); return true; } catch { return false; }
  }, []);
  /** The play button: one tap lets the browser play Otto's voice. */
  const resumePlayback = useCallback(() => { playerRef.current?.unlock(); void audioElRef.current?.play().catch(() => {}); setBlocked(false); }, []);

  useEffect(() => () => { if (aliveRef.current) teardown("ended"); }, [teardown]);
  // The microphone always ends by itself: after a minute with no words heard (the student's or Otto's) the call stops, muted or not.
  useEffect(() => {
    if (status !== "live") return;
    const t = window.setInterval(() => {
      if (aliveRef.current && liveSinceRef.current && Date.now() - liveSinceRef.current > 25 * 60_000) { setError("That was a long call, so it stopped to keep things light. Tap Voice mode to start a fresh one."); teardown("ended"); return; }
      if (aliveRef.current && Date.now() - lastHeardRef.current > 60_000) { setError("Stopped listening after a minute of silence. Tap Voice mode to continue."); teardown("ended"); }
    }, 5000);
    return () => window.clearInterval(t);
  }, [status, teardown]);
  return { status, error, speaking, muted, blocked, toolMode, start, stop, setMuted, sendImage, sendText, resumePlayback };
}
