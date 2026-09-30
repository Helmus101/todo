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
 *  classifies as echo once its LAST word also sits in the spoken reply. (Unit-tested in tests/run.mjs.) */
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

export interface EchoFilter {
  /** Call when TTS starts, with the reply text being synthesized. Re-call on a new utterance while the
   *  synth flag stayed true (a second reply queued back-to-back) — it re-arms the window. */
  speechStarted(text: string): void;
  /** Call when TTS stops — the echo TAIL window starts here. */
  speechEnded(): void;
  /** Classify recognition text (final or interim): true → DROP (Otto's own voice coming back). */
  isEcho(heard: string): boolean;
}

/** The stateful half of echo defense. isLikelyEcho is pure text comparison, but the LOOP the recognizer
 *  produces needs time-awareness, and this is where the old guard's holes were:
 *  1. RECOGNITION PIPELINE LAG — a final result for Otto's echo often lands AFTER synth.speaking has
 *     already flipped false (the recognizer finalizes on its own pause schedule, not ours), so a guard
 *     keyed on the speaking flag alone skips the check exactly when the echo arrives. The filter keeps a
 *     tail window (speechEnded timestamp + ECHO_TAIL_MS) during which anything matching the just-spoken
 *     reply is still classified as echo.
 *  2. THE RECURRING LOOP ITSELF — even one leaked echo gets SENT as a student message; Otto then replies
 *     to it (often re-quoting the same math), which is spoken, re-echoed, re-sent… Insurance: the reply
 *     text being spoken right now is remembered, and a heard utterance EQUAL to it is dropped regardless
 *     of timing — a student repeating Otto's full reply verbatim into the mic, word for word, doesn't
 *     happen; his own voice coming back late does.
 *  Plain factory (not a hook) so it's trivially unit-testable and usable from any surface. One instance
 *  per mounted voice surface (AskOttoPanel, TaskCard's TaskChat, StudyHelpPanel) — driven by that
 *  surface's synth.speaking transitions. */
export function createEchoFilter(tailMs = 5000): EchoFilter {
  let spokenText = "";
  let speaking = false;
  let speechEndedAt = 0;
  let recentReplies: string[] = []; // Track last few replies to catch delayed echoes
  return {
    speechStarted(text) {
      spokenText = text || "";
      speaking = true;
      speechEndedAt = 0;
      // Add to recent replies for loop detection
      if (spokenText) {
        recentReplies.push(spokenText);
        if (recentReplies.length > 5) recentReplies.shift();
      }
    },
    speechEnded() {
      speaking = false;
      speechEndedAt = Date.now();
    },
    isEcho(heard) {
      if (!spokenText) return false;
      const heardNorm = normalizeForEcho(heard);
      if (!heardNorm) return false;
      
      // Insurance #2: verbatim repeat of the reply currently/just spoken — no time bound. This is the
      // loop-killer: even if every other window misses, the echo's content IS the reply.
      if (heardNorm === normalizeForEcho(spokenText)) return true;
      
      // Check against recent replies to catch delayed echoes from previous turns
      for (const reply of recentReplies) {
        if (heardNorm === normalizeForEcho(reply)) return true;
      }
      
      const inWindow = speaking || (speechEndedAt > 0 && Date.now() - speechEndedAt < tailMs);
      if (!inWindow) return false;
      return isLikelyEcho(spokenText, heard);
    },
  };
}
