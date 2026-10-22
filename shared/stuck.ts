// "Two failed tries means explain" is a rule the tutor model follows only some of the time (measured in the regression suite),
// so it is backed by this code: the page counts how many times in a row the student has said they don't know, and if the
// tutor's reply is still only a guiding question, it sends the tutor a private note to explain. Pure, so it can be tested.

const STUCK = /\b(i don'?t know|i do not know|no idea|i'?m lost|i am lost|i don'?t get (it|this|that)|don'?t understand|do not understand|i have no clue|no clue|idk|i'?m confused|i give up|i can'?t do (it|this))\b/i;

/** The student's turn is mainly "I don't know" (short, and not an attempt). */
export function isStuckTurn(text: string): boolean {
  const t = String(text || "").trim();
  return !!t && t.split(/\s+/).length <= 14 && STUCK.test(t);
}

/** Consecutive stuck turns: reset by any turn that is an actual attempt. */
export function nextStuckCount(prev: number, studentText: string): number {
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
