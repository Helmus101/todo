// Audio plumbing for the live voice: Gemini Live takes 16 kHz 16-bit mono PCM in and sends 24 kHz 16-bit mono PCM out, both as base64.

export const MIC_RATE = 16000;
export const SPEAKER_RATE = 24000;

/** Linear-interpolation resample of mono float samples. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(input.length - 1, i0 + 1), frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] / (input[i] < 0 ? 0x8000 : 0x7fff);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Mic samples (any rate) → the base64 PCM16 chunk Gemini Live expects. */
export function micChunk(samples: Float32Array, sampleRate: number): string {
  const pcm = floatToPcm16(resample(samples, sampleRate, MIC_RATE));
  return bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

/** A base64 PCM16 chunk from Gemini → float samples at SPEAKER_RATE. */
export function speakerChunk(b64: string): Float32Array {
  const bytes = base64ToBytes(b64);
  const even = bytes.byteLength - (bytes.byteLength % 2);
  return pcm16ToFloat(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even)));
}
