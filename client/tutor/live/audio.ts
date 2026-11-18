import { SPEAKER_RATE, micChunk, speakerChunk } from "./pcm.ts";

/** Microphone → fixed ~100 ms base64 PCM16 chunks (16 kHz), through an AudioWorklet loaded from /otto-tap.js (same origin: the CSP forbids blob: scripts). */
export interface Mic { setMuted(m: boolean): void; stop(): void; level(): number }

export async function startMic(onChunk: (b64: string) => void): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  let ctx: AudioContext;
  try { ctx = new AudioContext({ sampleRate: 16000 }); } catch { ctx = new AudioContext(); } // 16 kHz capture: the browser resamples with a proper filter (clearer speech recognition)
  await ctx.audioWorklet.addModule("/otto-tap.js");
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
/** One speaker context for the whole page. Browsers only let sound start from a tap, but the call often starts a moment after the tap (after the session is created),
 *  so the context is created and resumed inside the tap by unlockAudio() and reused by every Player; a context made later would sit suspended and Otto would be silent. */
let sharedCtx: AudioContext | null = null;
export function unlockAudio(): AudioContext {
  if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new AudioContext();
  if (sharedCtx.state === "suspended") void sharedCtx.resume().catch(() => {});
  return sharedCtx;
}

export class Player {
  private ctx: AudioContext | null = null;
  private next = 0;
  private live = new Set<AudioBufferSourceNode>();
  constructor(private onSpeaking: (s: boolean) => void) {}
  get state(): AudioContextState | "none" { return this.ctx ? this.ctx.state : "none"; }
  /** Call from a click so the browser allows sound. */
  unlock() { this.ctx = unlockAudio(); }
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
  get active() { return this.live.size > 0; }
  interrupt() {
    for (const s of this.live) { try { s.onended = null; s.stop(); } catch { /* already stopped */ } }
    this.live.clear(); this.next = 0; this.onSpeaking(false);
  }
  close() { this.interrupt(); this.ctx = null; } // the shared context stays open for the next call
}
