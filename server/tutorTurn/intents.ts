// What the student is asking for, beyond the generic detectors: "put the PROBLEM on the board" (not "write my work"),
// "something totally different", and the statement of the problem itself, so code can put it on the board whatever the
// model did. Pure.
import { posesProblemInProse } from "../tutorAdapt.ts";

const WRITE_VERB = /\b(?:write|writ|put|add|place|post|show|display|copy|type|écris|ecris|mets|affiche|note)\b/i;
const PROBLEM_WORD = /\b(?:problem|problems|prob|question|exercise|exercice|énoncé|enonce|probl[eè]me|task)\b/i;
const BOARD_WORD = /\b(?:board|whiteboard|baord|boad|bord|tableau|screen)\b/i;

/** "write the problem on the board" — the PROBLEM, not their own working (typos tolerated). */
export function asksToWriteProblem(message: string): boolean {
  const m = String(message || "");
  if (m.length > 400) return false;
  return WRITE_VERB.test(m) && PROBLEM_WORD.test(m) && BOARD_WORD.test(m);
}

/** "new problem", "totally different", "not the same idea" — they want something else, not a variation. */
export function wantsDifferent(message: string): boolean {
  return /\b(?:new|different)\s+(?:problem|question|exercise|topic|one|thing)\b|\b(?:next|another)\s+topic\b|\b(?:totally|completely|entirely)\s+different\b|\bnot\s+(?:the\s+)?same\b|\bsomething\s+(?:else|different|new)\b|\bchange\s+(?:topic|subject)\b|\b(?:nouveau|autre)\s+(?:probl[eè]me|exercice|sujet)\b|\btout\s+autre\b/i.test(String(message || ""));
}

/** The text of a problem Otto stated in prose: the sentences from the scenario up to and including the question,
 *  without a lead-in sentence that has no numbers ("Let's switch to…"). "" when there is none. */
export function problemFromProse(text: string): string {
  const sents = String(text || "").replace(/\s+/g, " ").match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [];
  const s = sents.map((x) => x.trim()).filter(Boolean);
  while (s.length > 1 && !/\d/.test(s[0])) s.shift();
  const out = s.join(" ").slice(0, 600);
  return posesProblemInProse(out) ? out : "";
}

/** The problem to put on the board: this turn's own `problem` op, else the last problem Otto stated in prose, else the
 *  open exercise, else the student's own stated problem. */
export function problemStatement(i: { opQuestion?: string; history: { role: string; text: string }[]; openProblem?: string; studentStated?: string }): string {
  if (i.opQuestion && i.opQuestion.trim().length > 20) return i.opQuestion.trim().slice(0, 600);
  for (const h of [...i.history].reverse()) {
    if (h.role !== "assistant") continue;
    const p = problemFromProse(h.text);
    if (p) return p;
  }
  return (i.openProblem || i.studentStated || "").trim().slice(0, 600);
}

/** "give me another", "a harder one", "another to try" — the one-tap chips and their plain-text cousins. */
export function wantsMoreExercises(message: string): boolean {
  return /\b(?:give me|donne[- ]moi|donne-m'en|i want|je veux|j'en veux)\b[^.?!]{0,20}\b(?:another|a (?:harder|easier|new|similar)|un (?:autre|plus))\b|\banother (?:one|to try|exercise|problem)\b|\b(?:harder|easier|more difficult|plus (?:dur|difficile|facile))\s*(?:one|exercise|problem|question)?\b[^.?!]*$/i.test(String(message || ""));
}

/** An explicit ask for harder or easier overrides what the log says. */
export function difficultyAsked(message: string): "harder" | "easier" | null {
  const m = String(message || "");
  if (/\b(?:harder|more difficult|more challenging|tougher|plus (?:dur|difficile)|plus compliqu)/i.test(m)) return "harder";
  if (/\b(?:easier|simpler|less difficult|plus facile|plus simple)/i.test(m)) return "easier";
  return null;
}

/** "i don't see anything", "what is the question asking", "which question", "nothing on the board" — they can't see or place the problem. */
export function cantSeeProblem(message: string): boolean {
  return /\b(?:i (?:don'?t|do not|can'?t|cannot) see (?:anything|it|the (?:problem|question))|(?:don'?t|can'?t) see (?:anything|the (?:problem|question))|nothing (?:is )?(?:on|in) (?:the )?(?:board|baord)|what(?:'s| is| are) (?:the )?(?:question|problem) (?:asking|even)|what is (?:it|this|the question) asking|what am i (?:solving|supposed to)|which (?:question|problem)|what is just on (?:the )?bo|je (?:ne )?vois (?:rien|pas)|quelle question)\b/i.test(String(message || ""));
}
