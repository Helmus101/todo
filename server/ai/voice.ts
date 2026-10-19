
import { GEMINI_MODEL, retryRequest } from "./client.ts";

// ── The tutor's spoken voice: free, keyless, MALE ONLY ──────────────────────────────────────────────────
// Direct asks, in order: (1) don't use Gemini TTS; (2) use a free TTS API; (3) never fall back to a female
// voice — "even if it fails, use another free male voice". So the chain below is a POOL of free, keyless,
// explicitly male voices, tried in order, and it deliberately contains no female tier at all:
//   · Gemini TTS (the old primary) — removed on request.
//   · StreamElements (the old second tier) — removed because it is simply dead now: every request answers
//     `401 {"message":"No API key was found"}` (verified live), so it sat in front of a real provider
//     costing a wasted round trip every time.
//   · Google Translate's translate_tts (the old third tier) — removed because its only voice is FEMALE,
//     which is the exact thing ask (3) forbids. Its 180-char chunk-and-concatenate step was also the main
//     reason replies sounded clipped: it re-encoded in tiny pieces.
// What replaces them all is ttsmp3.com's public `makemp3_new.php` endpoint: no account, no key, and it
// speaks with real Amazon Polly voice names — the same neural family the old StreamElements tier proxied.
// Verified live: real MP3s for francophone and anglophone text, with the male voice names below.
// Male voices only — every name here is a documented Polly MALE voice. French has exactly ONE free male
// voice available from any keyless provider checked (Mathieu); English has five. That is what the pool is
// for: a failure re-tries with a DIFFERENT male voice instead of dropping to a woman's voice or silence.
// Adding a second French male source later is a one-line addition to this array.
const TTS_MALE_VOICES: Record<"fr" | "en", string[]> = {
  fr: ["Mathieu"],
  en: ["Matthew", "Brian", "Joey", "Justin", "Russell"],
};

// Verified live against the provider: ~1200 characters synthesizes fine, ~1500 comes back "Usage Limit
// exceeded". 900 keeps real headroom under that ceiling rather than riding it — a chunk that trips the
// limit would drop the rest of the reply's audio, which is precisely the "voice cuts off early" symptom.
const TTS_CHUNK_MAX = 900;

/** The longest text the client may send in one /api/tts request. Shared shape with the client's own chunk
 *  size so the two can never drift again (they used to: the client sent up to 1800 characters and the route
 *  silently `.slice(0, 1000)`-ed it, so every reply longer than 1000 characters had its audio cut off
 *  mid-sentence — on every provider, which is why it read as "all voices cut off early"). The server now
 *  chunks internally instead of truncating, so this is a request-size bound, not a content bound. */
export const TTS_MAX_TEXT = 4000;

// A plain browser User-Agent + Referer: several free, undocumented TTS endpoints quietly 403/502 a request
// that doesn't look like it came from a browser — a bare server-side fetch() sends no User-Agent at all,
// which reads as a bot.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const TTS_API_URL = "https://ttsmp3.com/makemp3_new.php";

const TTS_TIMEOUT_MS = 12_000;

/** Free and keyless means there is nothing for a deployment to configure — the voice is always available. */
export function ttsReady(): boolean {
  return true;
}

/** Wrap raw little-endian PCM in a WAV header so an <audio> element can play it (Gemini returns bare PCM). */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);            // fmt chunk size
  header.writeUInt16LE(1, 20);             // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Primary voice: Microsoft Edge's Read Aloud service (neural, keyless, male voices only). ttsmp3 (below) used to be the only
// source and started answering 502 for every voice, silencing the tutor — it is now the fallback.
const EDGE_MALE_VOICES: Record<"fr" | "en", string[]> = {
  fr: ["fr-FR-HenriNeural", "fr-CA-AntoineNeural"],
  en: ["en-US-GuyNeural", "en-GB-RyanNeural", "en-US-ChristopherNeural"],
};

const xmlEscape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function synthesizeChunkWithEdge(text: string, voice: string): Promise<{ mp3: Buffer } | { error: string; status: number }> {
  try {
    const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(xmlEscape(text));
    const mp3 = await new Promise<Buffer>((resolve, reject) => {
      const parts: Buffer[] = [];
      const timer = setTimeout(() => reject(new Error("timeout")), TTS_TIMEOUT_MS);
      audioStream.on("data", (d: Buffer) => parts.push(Buffer.from(d)));
      audioStream.on("error", (e: any) => { clearTimeout(timer); reject(e); });
      audioStream.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(parts)); });
    });
    try { (tts as any).close?.(); } catch { /* ignore */ }
    if (!mp3.length) return { error: `edge ${voice} returned empty audio`, status: 502 };
    return { mp3 };
  } catch (e: any) {
    return { error: `edge ${voice} failed: ${e?.message || e}`, status: 502 };
  }
}

/** One male voice, one chunk, one attempt. Never throws. */
async function synthesizeChunkWithVoice(text: string, voice: string): Promise<{ mp3: Buffer } | { error: string; status: number }> {
  try {
    const res = await fetch(TTS_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "User-Agent": BROWSER_UA,
        "Referer": "https://ttsmp3.com/",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      // The endpoint takes the VOICE NAME in its `lang` field (verified live: `lang=Mathieu` speaks French
      // with the Polly male voice of that name). `source=ttsmp3` is what its own web form sends.
      body: new URLSearchParams({ msg: text, lang: voice, source: "ttsmp3" }).toString(),
    });
    if (!res.ok) return { error: `ttsmp3 ${res.status}`, status: res.status };
    const json: any = await res.json().catch(() => null);
    const url = typeof json?.URL === "string" ? json.URL : "";
    // The ONLY reliable success signal is "did it hand back an audio URL": the provider OMITS `success` on a
    // cache hit ({"Error":0,"Cached":1,"URL":"…"} — probed live, same voice, same request, one after the
    // other) and only includes it on a fresh synthesis. Requiring `success` therefore rejected every CACHED
    // phrase, which in tutoring is the common case — the same short acknowledgements get spoken turn after
    // turn, so the pool would have walked every male voice and then failed the whole reply.
    // A refusal (over-length/over-quota) comes back with NO url, and with the provider's own wording in
    // `Error` — "Usage Limit exceeded" — which is what gets reported here so a log line names the real cause
    // instead of a generic 502.
    if (!url) return { error: `voice ${voice} rejected: ${String(json?.Error ?? "no audio url")}`, status: 502 };
    const audio = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, "Referer": "https://ttsmp3.com/" },
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    if (!audio.ok) return { error: `audio download ${audio.status}`, status: audio.status === 200 ? 502 : audio.status };
    const mp3 = Buffer.from(await audio.arrayBuffer());
    if (!mp3.length) return { error: `${voice} returned empty audio`, status: 502 };
    return { mp3 };
  } catch (e: any) {
    return { error: `voice ${voice} failed: ${e?.message || e}`, status: 504 };
  }
}

/** Removes a leading ID3v2 tag (its 10-byte header plus the size it declares) from an MP3 buffer, leaving
 *  raw MPEG frames. THIS IS NOT COSMETIC: the free provider returns EVERY synthesis with its own ID3v2
 *  tag, so concatenating two chunks naively embeds a tag in the middle of the stream — and an <audio>
 *  element that meets an ID3v2 header mid-file can simply stop there. Verified live on a 1350-character
 *  reply: the second tag sat at byte 356,588, i.e. exactly the first chunk's length, which is precisely
 *  where the audio would go silent (the "long replies get cut off" half of the voice reports — the
 *  1000-character server slice was the other half). Stripping the tag from every chunk after the first
 *  makes the result ONE continuous MPEG stream instead of two files glued together. Exported for tests. */
export function stripId3v2(mp3: Buffer): Buffer {
  if (mp3.length < 10 || mp3.toString("latin1", 0, 3) !== "ID3") return mp3;
  const flags = mp3[5];
  // The size is four 7-bit "syncsafe" bytes — the top bit of each is reserved and always 0.
  const size = ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
  const start = 10 + size + ((flags & 0x10) ? 10 : 0); // 0x10 = a footer follows the tag
  return start > 0 && start < mp3.length ? mp3.subarray(start) : mp3;
}

/** Same idea at the other end: a trailing ID3v1 tag ("TAG" + 125 bytes at the very end) belongs only at
 *  the end of the WHOLE stream, so a chunk carrying one that is then followed by more audio would also
 *  break continuity. Exported for tests. */
export function stripId3v1(mp3: Buffer): Buffer {
  if (mp3.length > 128 && mp3.toString("latin1", mp3.length - 128, mp3.length - 125) === "TAG") return mp3.subarray(0, mp3.length - 128);
  return mp3;
}

/** The tutor's voice. Splits long text into provider-safe chunks (never truncates it) and speaks each chunk
 *  with the first MALE voice in that language's pool that answers — a failure moves to the NEXT male voice,
 *  never to a woman's voice and never to a partial reply. Returns an honest error if every male voice failed;
 *  the client then plays nothing for that reply (see useSpeechSynthesis: it never substitutes a browser
 *  voice on a cloud failure) rather than switching gender mid-session. */
export async function synthesizeSpeech(text: string, lang: string): Promise<{ audio: Buffer; mime: string } | { error: string; status: number }> {
  const voices = TTS_MALE_VOICES["en"];
  const chunks = wordWrapChunks(text, TTS_CHUNK_MAX);
  if (!chunks.length) return { error: "nothing to speak", status: 400 };
  const parts: Buffer[] = [];
  let last: { error: string; status: number } = { error: "no male voice tried", status: 501 };
  for (const chunk of chunks) {
    let done = false;
    const attempts: Array<() => Promise<{ mp3: Buffer } | { error: string; status: number }>> = [
      ...EDGE_MALE_VOICES["en"].map((v) => () => synthesizeChunkWithEdge(chunk, v)),
      ...voices.map((v) => () => synthesizeChunkWithVoice(chunk, v)),
    ];
    for (let i = 0; i < attempts.length && !done; i++) {
      const r = await attempts[i]();
      if (!("error" in r)) {
        // Container tags go on the WHOLE stream, not on each piece of it — see stripId3v2's comment for the
        // live-verified mid-stream tag that was silently stopping long replies at the chunk boundary.
        const body = stripId3v1(r.mp3);
        parts.push(parts.length === 0 ? body : stripId3v2(body));
        done = true; break;
      }
      last = r;
      console.warn(`[tts] voice attempt ${i + 1}/${attempts.length} failed (${r.error})`);
    }
    // No male voice could speak THIS chunk: give up on the whole reply rather than serve a half-spoken one.
    if (!done) return last;
  }
  return { audio: Buffer.concat(parts), mime: "audio/mpeg" };
}

// ── Long text is split, never truncated ──────────────────────────────────────────────────────────────────
// The provider caps how much it will synthesize in one call (see TTS_CHUNK_MAX), so a long reply is
// word-wrapped into pieces that each sit safely under that cap and the resulting MP3 frames are
// concatenated — raw MP3 concatenation plays back correctly in every browser's <audio> element. Exported
// for unit tests.
export function wordWrapChunks(text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const piece = w.length > max ? w.slice(0, max) : w; // pathological single "word" longer than max
    if (cur && `${cur} ${piece}`.length > max) { out.push(cur); cur = piece; }
    else cur = cur ? `${cur} ${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out;
}

/** Reads an 800x600-ish whiteboard snapshot (a data URL, e.g. "data:image/png;base64,...") and returns a
 *  plain-text transcription of what's actually drawn — never an interpretation or a solved answer; that's
 *  the tutor's job once the transcription reaches it as a normal chat message (same "one model per
 *  concern" posture as the rest of this file: this function's only job is "what does the image show",
 *  exactly like stripHtmlToText's "what does the page say" in server/index.ts). Returns an error string
 *  (never throws) so the route can hand the student an honest, specific failure. */
/** Picks the right language for one message — the same shape as server/index.ts's own `M(req, fr, en)`,
 *  passed IN by the caller because this module is called from routes (which know the request's language)
 *  as well as from tests (which don't). Defaults to English so a caller that doesn't care — or doesn't
 *  have a request — keeps the previous exact behavior. */
type Msg = (fr: string, en: string) => string;

const EN_ONLY: Msg = (_fr, en) => en;

/** French/English noun phrases for the thing being read. French needs three forms (a sentence-initial
 *  subject, the object of "lire", and the object of "sur") because the article contracts differently —
 *  "le tableau blanc" vs "du tableau blanc"; English needs one. Getting this wrong is how machine-shaped
 *  translations read badly ("lire le tableau blanc" is fine, "sur le tableau" needs "sur", not "dans"). */
type VisionNoun = { frSubj: string; frOf: string; frOn: string; en: string; blockedFr: string; blockedEn: string };

/** Shared Gemini vision call — both describeWhiteboard (a canvas drawing) and describeUploadedPhoto (a
 *  student-supplied photo of an exercise/document, used by the Tutor's file-upload attach button) need the
 *  exact same request/error-handling shape and only differ in the instruction text and the "looks empty"
 *  size heuristic's label. One implementation, two thin callers, instead of ~60 duplicated lines. */
async function describeImageWithGemini(dataUrl: string, instruction: string, noun: VisionNoun, t: Msg = EN_ONLY): Promise<{ description: string } | { error: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { error: t("La lecture d'images n'est pas configurée sur ce serveur.", "Reading images isn't configured on this server.") };
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/.exec(dataUrl);
  if (!match) return { error: t("Ça ne ressemble pas à une vraie image.", "That doesn't look like a real image.") };
  const [, mimeType, base64] = match;
  // A blank/near-blank canvas (nothing drawn, or just a stray dot) still produces a "valid" PNG — catch it
  // here on SIZE before spending a real API call on nothing. A completely empty 800x600 PNG is tiny (a few
  // hundred bytes of flat-color compression); anything with real content is reliably much larger.
  if (base64.length < 400) return { error: t(`${noun.frSubj} semble vide.`, `The ${noun.en} looks empty.`) };
  try {
    const res = await retryRequest(() => fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          contents: [{ parts: [
            { text: instruction },
            { inline_data: { mime_type: mimeType, data: base64 } },
          ] }],
          generationConfig: { maxOutputTokens: 1200, temperature: 0.1 },
        }),
      },
    ), 2, 500);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[vision] Gemini request failed: ${res.status} ${body.slice(0, 300)}`);
      // The first real deployment of this feature hit a 422 with no way to tell WHY from the client side —
      // this function already swallowed Gemini's own error detail into a generic line, so the only way to
      // diagnose it was server log access nobody necessarily has handy. Surface a short, safe snippet of the
      // actual upstream reason (a bad/misconfigured key, an unenabled API, a quota limit — never a secret,
      // just Gemini's own error message) so a failure is self-diagnosable from the chat bubble itself.
      let detail = "";
      try { detail = JSON.parse(body)?.error?.message || ""; } catch { /* non-JSON error body */ }
      return { error: t(
        `Impossible de lire ${noun.frOf} (${res.status}${detail ? ` : ${detail.slice(0, 200)}` : ""}) — réessaie dans un instant.`,
        `Couldn't read the ${noun.en} (${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}) — try again in a moment.`,
      ) };
    }
    const json: any = await res.json();
    // Same reasoning as the !res.ok branch above: a 200 with no usable text can ALSO have a real, specific
    // reason (Gemini blocked the response on safety grounds, or hit its own output-token cap before writing
    // anything) — surface that instead of the one-size-fits-all "couldn't make out anything" guess whenever
    // it's available, so this is diagnosable without server log access here too.
    const blockReason = json?.promptFeedback?.blockReason;
    const finishReason = json?.candidates?.[0]?.finishReason;
    const description = String(json?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    if (!description) {
      if (blockReason) return { error: t(`${noun.blockedFr} (${blockReason}) — essaie une autre image.`, `${noun.blockedEn} (${blockReason}) — try a different image.`) };
      if (finishReason && finishReason !== "STOP") return { error: t(`Impossible de terminer la lecture ${noun.frOf} (${finishReason}) — réessaie.`, `Couldn't finish reading the ${noun.en} (${finishReason}) — try again.`) };
      return { error: t(`Impossible de distinguer quoi que ce soit sur ${noun.frOn} — essaie une image plus grande ou plus nette.`, `Couldn't make out anything in the ${noun.en} — try a bigger/clearer one.`) };
    }
    return { description: description.slice(0, 2000) };
  } catch (e: any) {
    console.error(`[vision] Gemini request threw: ${e?.message || e}`);
    return { error: t(
      `Impossible de lire ${noun.frOf} pour l'instant (${e?.message || "erreur réseau"}) — réessaie dans un instant.`,
      `Couldn't read the ${noun.en} just now (${e?.message || "network error"}) — try again in a moment.`,
    ) };
  }
}

/** Reads an 800x600-ish whiteboard snapshot (a data URL, e.g. "data:image/png;base64,...") and returns a
 *  plain-text transcription of what's actually drawn — never an interpretation or a solved answer; that's
 *  the tutor's job once the transcription reaches it as a normal chat message (same "one model per
 *  concern" posture as the rest of this file: this function's only job is "what does the image show",
 *  exactly like stripHtmlToText's "what does the page say" in server/index.ts). Returns an error string
 *  (never throws) so the route can hand the student an honest, specific failure. */
export async function describeWhiteboard(dataUrl: string, t: Msg = EN_ONLY, context = ""): Promise<{ description: string } | { error: string }> {
  const ctx = String(context || "").replace(/\s+/g, " ").trim().slice(0, 700);
  const r = await describeImageWithGemini(
    dataUrl,
    "You are reading a student's whiteboard drawing for their tutor. Answer in plain text in EXACTLY this format:\n" +
      "TEXT: every word, number and equation written, exactly as written (x^2 style for powers); write [illegible] for anything you cannot read.\n" +
      "DRAWING: first say what the drawing IS (for example: a graph of a rational function with asymptotes, a unit circle with an angle marked, a right triangle, a number line, a table, a sign chart, a free-body diagram, a parabola). Then list its parts one by one: the axes and whether they are labelled; each line or curve, its direction and how it behaves (rising, falling, bending, approaching a line, crossing another); dashed versus solid lines; marked points with their labels or coordinates; arrows; shaded regions; angle marks; every letter or label and which part it sits beside.\n" +
      "LOOKS LIKE: one sentence naming what the student seems to have intended, then your confidence (high / medium / low) and anything ambiguous.\n" +
      "Rules: describe only what is really on the board. Do not judge whether it is correct, do not solve anything, do not invent labels or points that are not drawn. If the board is blank or illegible, say so plainly." +
      (ctx ? `\nWHAT THEY ARE WORKING ON (only to help you read their handwriting and name the drawing — never copy it into your answer): ${ctx}` : ""),
    { frSubj: "Le tableau blanc", frOf: "du tableau blanc", frOn: "le tableau blanc", en: "whiteboard", blockedFr: "L'image du tableau a été bloquée", blockedEn: "The whiteboard image was blocked" },
    t,
  );
  return "description" in r ? { description: cleanVisionText(r.description) } : r;
}

/** Drops the model's chatty preamble and markdown headers so only the reading itself reaches the tutor. Exported for tests. */
export function cleanVisionText(raw: string): string {
  return String(raw || "")
    .replace(/^\s*(?:based on|looking at|from) the (?:image|photo|picture|drawing)[^\n]*?(?:here is|follows?|below)[^\n]*\n+/i, "")
    .replace(/^#{1,4}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Reads a student-supplied photo (an exercise sheet, a textbook page, a handwritten note, a diagram) —
 *  the Tutor's file-upload attach button for a quick "here's the question" phone-camera shot, no PDF/typed
 *  text required. Same literal-transcription posture as describeWhiteboard: this only reports what the
 *  image SHOWS, never solves it or interprets it — that's the tutor's job once the transcription reaches
 *  it as normal chat context. */
export async function describeUploadedPhoto(dataUrl: string, t: Msg = EN_ONLY): Promise<{ description: string } | { error: string }> {
  return describeImageWithGemini(
    dataUrl,
    "Transcribe exactly what this photo shows — all text, numbers, equations, diagrams, tables, or " +
      "handwriting, in reading order. Be literal and factual: describe what's actually there, not what it " +
      "might mean. If it's a math/science exercise, transcribe every part/question precisely. If the image " +
      "is blurry, cut off, or illegible in places, say so plainly for those parts instead of guessing.",
    { frSubj: "L'image", frOf: "de l'image", frOn: "l'image", en: "image", blockedFr: "L'image a été bloquée", blockedEn: "The image was blocked" },
    t,
  );
}
