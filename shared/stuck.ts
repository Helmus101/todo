import { classifySafety } from "./safety.ts";
// "Two failed tries means explain" is a rule the tutor model follows only some of the time (measured in the regression suite),
// so it is backed by this code: the page counts how many times in a row the student has said they don't know, and if the
// tutor's reply is still only a guiding question, it sends the tutor a private note to explain. Pure, so it can be tested.

const STUCK = /\b(i don'?t know|i do not know|no idea|i'?m lost|i am lost|i don'?t get (it|this|that)|don'?t understand|do not understand|i have no clue|no clue|idk|i'?m confused|i give up|i can'?t do (it|this)|je (ne )?sais pas|aucune id[ée]e|j'?ai pas compris|je (ne )?comprends pas|je suis perdu[e]?|j'?y comprends rien|j'?abandonne|no s[eé]|ni idea|no entiendo|estoy perdid[oa]|ich wei(?:ß|ss) nicht|keine ahnung|ich verstehe (?:es |das )?nicht)\b/i;

/** The student's turn is mainly "I don't know" (short, and not an attempt). */
export function isStuckTurn(text: string): boolean {
  const t = String(text || "").trim();
  return !!t && t.split(/\s+/).length <= 14 && STUCK.test(t);
}

/** Consecutive stuck turns: reset by any turn that is an actual attempt. */
export function nextStuckCount(prev: number, studentText: string): number {
  // A student in distress is not "stuck on the maths": never push an explanation at them.
  if (classifySafety(studentText)?.kind === "crisis") return 0;
  return isStuckTurn(studentText) ? prev + 1 : 0;
}

/** The tutor's reply is just another guiding question, with no real explanation before it. */
export function isOnlyAQuestion(tutorText: string): boolean {
  const sentences = String(tutorText || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  if (!sentences.length) return false;
  const statements = sentences.filter((s) => !s.trim().endsWith("?")).filter((s) => s.split(/\s+/).length >= 6);
  return sentences[sentences.length - 1].trim().endsWith("?") && statements.length < 2;
}

export const EXPLAIN_NOW_NOTE = "(Private note for you, not from the student: they have now said they don't know twice on this step. Explain it now: state the idea in full in plain words, with a tiny worked example on a different case, then give them a similar one to try. Do not ask another guiding question first.)";

const LATIN_SCRIPT_LANGS = /^(?:en|fr|es|de|it|pt|nl|pl|sv|da|no|nb|fi|ro|cs|sk|hu|tr|id|ms|vi|ca|hr|sl|lt|lv|et)\b/i;
/** Speech recognition heard noise as words of another script ("뚜루뚜루 뚜루" in an English session), or nothing but symbols: not something the
 *  student said. Only for languages written in Latin script; a stray Greek letter (θ, π) inside a sentence is fine. Pure. */
export function unclearSpeech(text: string, lang = "en"): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  const letters = [...t].filter((ch) => /\p{L}/u.test(ch));
  if (!letters.length) return !/\d/.test(t);
  if (!LATIN_SCRIPT_LANGS.test(lang || "en")) return false;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin / letters.length < 0.5;
}
