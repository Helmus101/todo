import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api.ts";
import { ASK_OTTO_DECLARATION, LIVE_TOOL_NAME, liveInstructions, sayThis, type LiveToolResult } from "../../../shared/liveTutor.ts";
import { startMic, Player, type Mic } from "./audio.ts";

export type LiveStatus = "idle" | "connecting" | "live" | "ended" | "unavailable";

export interface LiveOptions {
  subject?: string;
  level?: string;
  /** Otto's real opening line (from memory of past sessions): the voice greets in its own words from it. */
  opener?: string;
  resuming?: boolean;
  /** The brain: the student's words go to Otto's engine; what comes back is what the voice says. Never throws. */
  ask: (studentSaid: string) => Promise<LiveToolResult>;
  /** Called with each finished student utterance and each finished Otto utterance (captions). */
  onCaption?: (who: "you" | "otto", text: string, done: boolean) => void;
}

/** One live conversation with Gemini Live. The voice model only talks; every thought goes through `ask`. Failures end the call
 *  quietly and set status "unavailable" so the caller can fall back to the classic voice. */
export function useGeminiLive(opts: LiveOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [thinking, setThinking] = useState(false);
  const sessionRef = useRef<any>(null);
  const micRef = useRef<Mic | null>(null);
  const playerRef = useRef<Player | null>(null);
  const heardRef = useRef("");   // the student's words this turn, from the model's own transcription (more exact than its paraphrase)
  const saidRef = useRef("");
  const aliveRef = useRef(false);

  const teardown = useCallback((next: LiveStatus) => {
    aliveRef.current = false;
    try { sessionRef.current?.close(); } catch { /* already closed */ }
    sessionRef.current = null;
    micRef.current?.stop(); micRef.current = null;
    playerRef.current?.close(); playerRef.current = null;
    setSpeaking(false); setThinking(false); setMutedState(false);
    setStatus(next);
  }, []);

  const stop = useCallback(() => teardown("ended"), [teardown]);

  const start = useCallback(async () => {
    if (aliveRef.current) return;
    aliveRef.current = true;
    setError(null); setStatus("connecting");
    const player = new Player(setSpeaking);
    player.unlock(); // inside the click
    playerRef.current = player;
    try {
      const [{ GoogleGenAI, Modality }, tok] = await Promise.all([import("@google/genai"), api.liveToken()]);
      if (!aliveRef.current) return;
      const ai = new GoogleGenAI({ apiKey: tok.token });
      const o = optsRef.current;
      const session = await ai.live.connect({
        model: tok.model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: liveInstructions({ subject: o.subject, level: o.level, opener: o.opener, resuming: o.resuming }),
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [{ functionDeclarations: [ASK_OTTO_DECLARATION as any] }],
        } as any,
        callbacks: {
          onopen: () => { /* the first server message confirms */ },
          onmessage: (msg: any) => handle(msg),
          onerror: (e: any) => { if (aliveRef.current) { setError(String(e?.message || "The voice connection failed.")); teardown("unavailable"); } },
          onclose: () => { if (aliveRef.current) teardown("ended"); },
        },
      });
      if (!aliveRef.current) { try { session.close(); } catch { /* */ } return; }
      sessionRef.current = session;
      micRef.current = await startMic((b64) => { try { sessionRef.current?.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } }); } catch { /* socket closing */ } });
      setStatus("live");
      // The model speaks first: nudge it with a plain text turn so it greets from the opening line.
      session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "(The student has just joined. Begin now.)" }] }], turnComplete: true });
    } catch (e: any) {
      const unavailable = e?.status === 503 || e?.status === 502 || e?.status === 429 || e?.status === 403 || /NotAllowed|Permission|denied/i.test(String(e?.name || e?.message));
      setError(e?.status === 429 ? String(e?.message || "Live voice limit reached for today.") : /NotAllowed|Permission|denied/i.test(String(e?.name || e?.message)) ? "Microphone blocked — allow it for this site and try again." : "Live voice isn't available right now.");
      teardown(unavailable ? "unavailable" : "ended");
    }

    function handle(msg: any) {
      if (!aliveRef.current) return;
      const sc = msg.serverContent;
      if (sc) {
        if (sc.interrupted) { player.interrupt(); }
        for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data) player.push(p.inlineData.data);
        if (sc.inputTranscription?.text) { heardRef.current += sc.inputTranscription.text; optsRef.current.onCaption?.("you", heardRef.current, false); }
        if (sc.outputTranscription?.text) { saidRef.current += sc.outputTranscription.text; optsRef.current.onCaption?.("otto", saidRef.current, false); }
        if (sc.turnComplete) {
          if (saidRef.current.trim()) optsRef.current.onCaption?.("otto", saidRef.current, true);
          saidRef.current = "";
        }
      }
      const calls = msg.toolCall?.functionCalls as Array<{ id: string; name: string; args?: { student_said?: string } }> | undefined;
      if (calls?.length) {
        void (async () => {
          const responses: any[] = [];
          for (const c of calls) {
            if (c.name !== LIVE_TOOL_NAME) { responses.push({ id: c.id, name: c.name, response: { error: "unknown tool" } }); continue; }
            const heard = heardRef.current.trim() || String(c.args?.student_said || "").trim();
            if (heardRef.current.trim()) optsRef.current.onCaption?.("you", heardRef.current, true);
            heardRef.current = "";
            setThinking(true);
            let result: LiveToolResult;
            // A slow brain must never leave the voice silent for good: after 45 s the voice is told to ask them to repeat.
            try { result = await Promise.race([optsRef.current.ask(heard), new Promise<LiveToolResult>((r) => setTimeout(() => r({ say: "", error: "That took too long. Ask the student to say it again." }), 45_000))]); } catch { result = { say: "", error: "Otto couldn't answer just now. Ask the student to say that again." }; }
            setThinking(false);
            responses.push({ id: c.id, name: c.name, response: result });
          }
          try { if (aliveRef.current) sessionRef.current?.sendToolResponse({ functionResponses: responses }); } catch { /* closing */ }
        })();
      }
    }
  }, [teardown]);

  const setMuted = useCallback((m: boolean) => { micRef.current?.setMuted(m); setMutedState(m); }, []);
  /** Have the voice say Otto's reply to something the student TYPED. */
  const say = useCallback((text: string) => {
    if (!aliveRef.current || !text.trim()) return;
    try { sessionRef.current?.sendClientContent({ turns: [{ role: "user", parts: [{ text: sayThis(text) }] }], turnComplete: true }); } catch { /* closing */ }
  }, []);
  const level = useCallback(() => micRef.current?.level() ?? 0, []);

  useEffect(() => () => { if (aliveRef.current) teardown("ended"); }, [teardown]);
  return { status, error, speaking, muted, thinking, start, stop, setMuted, say, level };
}
