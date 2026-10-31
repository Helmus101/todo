import { classifySafety } from "./safety.ts";
// "Two failed tries means explain" is a rule the tutor model follows only some of the time (measured in the regression suite),
// so it is backed by this code: the page counts how many times in a row the student has said they don't know, and if the
// tutor's reply is still only a guiding question, it sends the tutor a private note to explain. Pure, so it can be tested.

// Phrased the way students really say it, not only the textbook "I don't know": "I'm not getting it", "I don't get the momentum
// thing at all", "I don't see why that applies" are all the same signal and used to reset the count.
const STUCK = /\b(i don'?t know|i do not know|no idea|i'?m lost|i am lost|i don'?t (?:really |quite )?get (?:it|this|that)|i don'?t get (?:the|what|why|how) [^.?!]{0,40}|i'?m not getting (?:it|this|that)|i'?m not following|i don'?t (?:really |quite )?see (?:why|how)|don'?t understand|do not understand|not understanding|i have no clue|no clue|idk|i'?m confused|i give up|i can'?t do (?:it|this)|je (ne )?sais pas|aucune id[ée]e|j'?ai pas compris|je (ne )?comprends (?:pas|rien)|je capte rien|j'?y comprends rien|je suis perdu[e]?|j'?abandonne|no s[eé]|no lo (?:entiendo|veo)|ni idea|no entiendo|estoy perdid[oa]|ich wei(?:ß|ss) nicht|keine ahnung|ich verstehe (?:es |das )?nicht)\b/i;

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

/** They are asking to be shown, not quizzed: "just explain it", "explain it again", "walk me through it". One of these is enough for the
 *  page to send the explain-now note (a student who has to ask twice has already been wasted time). */
const ASK_EXPLAIN = /\b(?:just (?:tell|explain|show)|explain (?:it|this|that|why|how|again|properly)|explain (?:it |that |this )?(?:to me|again)|walk me through|show me how|stop asking|don'?t ask me|tell me the (?:idea|reason|rule)|explique(?:-moi)?|montre(?:-moi)?|dis-moi)\b/i;
export function askedToExplain(text: string): boolean {
  const t = String(text || "").trim();
  return !!t && t.split(/\s+/).length <= 20 && ASK_EXPLAIN.test(t);
}

/** The tutor's reply is just another guiding question, with no real explanation before it. */
export function isOnlyAQuestion(tutorText: string): boolean {
  const sentences = String(tutorText || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  if (!sentences.length) return false;
  const statements = sentences.filter((s) => !s.trim().endsWith("?")).filter((s) => s.split(/\s+/).length >= 6);
  return sentences[sentences.length - 1].trim().endsWith("?") && statements.length < 2;
}

export const EXPLAIN_NOW_NOTE = "(Private note for you, not from the student: they have told you twice that they don't get it, or they have asked you to explain. Do NOT ask another guiding question and do not rephrase the same question. Say the idea yourself now: plain words, real numbers, a tiny worked case that is not their own problem, a few sentences. Then one small check. If it still does not land, say so honestly, leave it for now and move to something they can do.)";

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
