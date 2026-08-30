// Synthesized focus-noise — replaces streaming ambient MP3s from a third-party CDN (pixabay hotlinks
// observed live returning 403/expired), which meant "audio" silently failed to play depending on which
// track was picked and whether that day's CDN link still resolved. Generating the waveform locally with
// the Web Audio API means playback never depends on network access or a third party's file staying up.
export type NoiseType = "white" | "pink" | "brown";

const BUFFER_SECONDS = 4; // short loop; noise has no audible seams when looped, unlike music/recordings

function makeNoiseBuffer(ctx: AudioContext, type: NoiseType): AudioBuffer {
  const length = ctx.sampleRate * BUFFER_SECONDS;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  if (type === "white") {
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  } else if (type === "pink") {
    // Paul Kellet's refined pink-noise filter — standard, cheap approximation.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      data[i] = pink * 0.11;
    }
  } else {
    // Brown noise: integrated (random-walk) white noise, normalized to avoid runaway DC drift.
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
  }
  return buffer;
}

export class NoisePlayer {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;

  play(type: NoiseType, volume: number): void {
    this.stop();
    const ctx = (this.ctx ||= new (window.AudioContext || (window as any).webkitAudioContext)());
    if (ctx.state === "suspended") void ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = makeNoiseBuffer(ctx, type);
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume / 100));
    source.connect(gain).connect(ctx.destination);
    source.start();
    this.source = source;
    this.gain = gain;
  }

  setVolume(volume: number): void {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, volume / 100));
  }

  stop(): void {
    if (this.source) { try { this.source.stop(); } catch { /* already stopped */ } this.source.disconnect(); this.source = null; }
    if (this.gain) { this.gain.disconnect(); this.gain = null; }
  }
}
