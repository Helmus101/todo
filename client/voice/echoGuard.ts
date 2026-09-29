// Echo discrimination for barge-in. Real interruption requires the mic to stay OPEN while Otto is
// speaking — but then the mic also hears Otto himself through the speakers, and without discrimination
// his own reply gets transcribed and re-sent as if the student said it (the exact feedback loop the old
// pause-the-mic-during-TTS design existed to prevent; that pause is also what made barge-in impossible —
// no audio reaches a dead mic). The Web Speech API gives no access to raw audio or echo-cancellation
// constraints, so discrimination has to be TEXTUAL: Otto can only echo words he is currently speaking,
// so heard text that appears inside the reply being spoken right now is echo; anything else is the
// student. Pure and unit-tested (tests/run.mjs) — both voice surfaces (AskOttoPanel, TaskCard) gate
// their interim and final results through this while `synth.speaking` is true.

/** Normalize for comparison: lowercase, strip punctuation (keep accents — French replies are the
 *  majority case), collapse whitespace. Kept forgiving on purpose: TTS reads aloud what the recognizer
 *  transcribes, but numbers/symbols come out differently ("1 − cos²θ" is spoken as words, recognized as
 *  words or digits) — matching on the LETTERS/words that survive normalization is the reliable signal. */
export function normalizeForEcho(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’'`]/g, " ")
    .replace(/[^a-zà-öø-ÿ0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when every word of `heard` appears in `spoken` IN ORDER (not necessarily adjacent) — the realistic
 *  echo shape: the recognizer transcribing Otto through the speakers drops or mangles the math tokens
 *  ("exactly that … is sin²θ" comes back as "exactly that is sin"), so a strict contiguous match misses
 *  real echoes. An ordered-subsequence match over 3+ words is still overwhelmingly echo: a student's own
 *  novel sentence almost never has ALL of its words inside what Otto is saying right now, in order — and
 *  the final word has to be present too, so a question that starts with common words ("is that…") only
 *  classifies as echo once its LAST word also sits in the spoken reply. */
function isOrderedSubsequence(spokenNorm: string, heardNorm: string): boolean {
  const sWords = spokenNorm.split(" ");
  let i = 0;
  for (const w of heardNorm.split(" ")) {
    let found = false;
    while (i < sWords.length) {
      if (sWords[i++] === w) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

/** True when `heard` is plausibly the TTS voice itself rather than the student talking over it.
 *  `spoken` is the reply text currently being synthesized; `heard` is interim or final recognition text.
 *  Short fragments (< 2 words) are never classified as echo — a student's "stop" or "attends" must
 *  always get through, and 1-2 words are too little signal to call echo on. A 2-word utterance only
 *  counts as echo when it's a CONTIGUOUS chunk of the spoken reply (adjacency is real signal at that
 *  length); 3+ words also match as an ordered subsequence, absorbing the mangled-math case above. */
export function isLikelyEcho(spoken: string, heard: string): boolean {
  const s = normalizeForEcho(spoken);
  const h = normalizeForEcho(heard);
  if (!s || !h) return false;
  const hWords = h.split(" ").length;
  if (hWords < 2) return false;
  // Containment either way: the echo is a (possibly partial, possibly slightly misheard) chunk of the
  // spoken reply. Checking the spoken-side prefix too catches the common case where the recognizer
  // lands mid-word and the transcription starts partway into a sentence.
  if (s.includes(h) || h.includes(s.slice(0, Math.min(s.length, h.length)))) return true;
  return hWords >= 3 && isOrderedSubsequence(s, h);
}
