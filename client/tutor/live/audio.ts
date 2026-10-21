import { SPEAKER_RATE, micChunk, speakerChunk } from "./pcm.ts";

/** Microphone → fixed ~100 ms base64 PCM16 chunks (16 kHz), through an AudioWorklet built from a Blob (no bundler config). */
const WORKLET = `class Tap extends AudioWorkletProcessor { process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch && ch.length) this.port.postMessage(ch.slice(0)); return true; } } registerProcessor("otto-tap", Tap);`;

export interface Mic { setMuted(m: boolean): void; stop(): void; level(): number }

export async function startMic(onChunk: (b64: string) => void): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "otto-tap");
  const mute = ctx.createGain();
  mute.gain.value = 0; // the tap must not play the mic back through the speakers
  let muted = false, last = 0;
  let buf: Float32Array[] = [], n = 0;
  const per = Math.round(ctx.sampleRate / 10);
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (muted) return;
    const f = e.data;
    let sum = 0; for (let i = 0; i < f.length; i += 8) sum += f[i] * f[i];
    last = Math.sqrt(sum / Math.max(1, f.length / 8));
    buf.push(f); n += f.length;
    if (n >= per) {
      const all = new Float32Array(n); let o = 0; for (const b of buf) { all.set(b, o); o += b.length; }
      buf = []; n = 0;
      onChunk(micChunk(all, ctx.sampleRate));
    }
  };
  src.connect(node); node.connect(mute); mute.connect(ctx.destination);
  return {
    setMuted(m) { muted = m; stream.getAudioTracks().forEach((t) => { t.enabled = !m; }); if (m) last = 0; },
    level: () => last,
    stop() { try { node.port.onmessage = null; src.disconnect(); node.disconnect(); } catch { /* closed */ } stream.getTracks().forEach((t) => t.stop()); void ctx.close().catch(() => {}); },
  };
}

/** Gapless playback of Gemini's 24 kHz PCM chunks, with an instant interrupt (barge-in). */
export class Player {
  private ctx: AudioContext | null = null;
  private next = 0;
  private live = new Set<AudioBufferSourceNode>();
  constructor(private onSpeaking: (s: boolean) => void) {}
  get state(): AudioContextState | "none" { return this.ctx ? this.ctx.state : "none"; }
  /** Call from a click so the browser allows sound. */
  unlock() { if (!this.ctx) this.ctx = new AudioContext(); if (this.ctx.state === "suspended") void this.ctx.resume(); }
  push(b64: string) {
    this.unlock();
    const ctx = this.ctx!;
    const samples = speakerChunk(b64);
    if (!samples.length) return;
    const buf = ctx.createBuffer(1, samples.length, SPEAKER_RATE);
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const s = ctx.createBufferSource();
    s.buffer = buf; s.connect(ctx.destination);
    this.next = Math.max(ctx.currentTime + 0.02, this.next);
    s.start(this.next); this.next += buf.duration;
    this.live.add(s); this.onSpeaking(true);
    s.onended = () => { this.live.delete(s); if (!this.live.size) this.onSpeaking(false); };
  }
  interrupt() {
    for (const s of this.live) { try { s.onended = null; s.stop(); } catch { /* already stopped */ } }
    this.live.clear(); this.next = 0; this.onSpeaking(false);
  }
  close() { this.interrupt(); void this.ctx?.close().catch(() => {}); this.ctx = null; }
}
