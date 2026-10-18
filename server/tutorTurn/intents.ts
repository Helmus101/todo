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
  // Split only where punctuation is followed by whitespace — a decimal point ("5.0 kg") is not a sentence end.
  const sents = String(text || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
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

/** "can you actually do momentum", "can we go back to energy", "let's work on waves" — they name a different topic to work on. */
export function wantsTopicSwitch(message: string): boolean {
  const m = String(message || "");
  if (m.length > 240 || /^\s*\[/.test(m)) return false;
  return /\b(?:can|could|shall|may) (?:you|we|i) (?:please |actually |just )*(?:do|go (?:back )?to|work on|switch to|move (?:on )?to|talk about|learn|study|look at|try|revisit|cover)\s+(?!it\b|that\b|this\b|the (?:same|last|next|previous)\b|another\b|more\b|some\b|a\b|an\b|one\b|again\b|then\b|now\b|so\b)([a-zà-ÿ][a-zà-ÿ' -]{2,30})/i.test(m)
    || /\b(?:let'?s|i want to|i need to|i'd like to|on voudrait|je veux|peut-on|on peut) (?:please |actually |just )*(?:do|go (?:back )?to|work on|switch to|move (?:on )?to|talk about|learn|study|revisit|faire|passer à|revoir|travailler)\s+(?!it\b|that\b|this\b|another\b|more\b|again\b|the (?:same|last|next))([a-zà-ÿ][a-zà-ÿ' -]{2,30})/i.test(m);
}

export type Complaint = "board" | "unclear" | "repeat" | "ignored" | "wrong" | "setup";

/** The student is telling Otto something went wrong with HIS side of the session. Each kind has its own repair (see the facts block). */
export function studentComplaint(message: string): Complaint | null {
  const m = String(message || "");
  if (m.length > 300 || /^\s*\[/.test(m)) return null;
  if (/\b(?:you(?:'ve| have)? (?:didn'?t|did not|never|haven'?t) (?:put|write|wrote|written|draw|show|add)|(?:it'?s|that'?s|is|are) not on the (?:board|baord)|(?:i )?(?:don'?t|can'?t|cannot) see (?:it|that|the (?:equation|formula|line|graph|diagram|table))|tu (?:n'?as|as) pas (?:écrit|mis)|(?:c'est|ce n'est) pas au tableau)\b/i.test(m)) return "board";
  if (/\bwhich (?:masses|blocks|objects|numbers|values|one|problem|question|equation|line)\b[^.?!]{0,30}\b(?:talking about|mean|referring)|what (?:are|is) (?:the|those|these) (?:masses|blocks|numbers|values)\b|you haven'?t (?:said|told|given)|haven'?t (?:said|told me) (?:what|any)|de quel(?:le)?s? .{0,20} (?:parles|parlez)/i.test(m)) return "setup";
  if (/\b(?:you (?:already|just) (?:said|told|asked)|(?:you )?(?:keep|already) (?:saying|asking)|same (?:question|thing) again|you asked (?:me )?that|tu l'as déjà dit|tu me redemandes)\b/i.test(m)) return "repeat";
  if (/\b(?:that'?s not what i (?:asked|said|meant)|you(?:'re| are) not (?:listening|answering)|you (?:ignored|didn'?t answer)|i (?:asked|said) (?:about|for)|ce n'est pas ce que j'ai (?:demandé|dit)|tu n'as pas répondu)\b/i.test(m)) return "ignored";
  if (/\b(?:that'?s (?:wrong|not right|incorrect)|you(?:'re| are) wrong|you made a mistake|isn'?t that wrong|i think you(?:'re| are) wrong|c'est faux|tu te trompes)\b/i.test(m)) return "wrong";
  if (/\b(?:i (?:still )?(?:don'?t|do not) (?:get|understand) (?:your|what you|that explanation|how you)|(?:your|that) explanation (?:is|was) (?:confusing|unclear)|that (?:doesn'?t|does not) make sense|too (?:fast|confusing)|je ne comprends pas (?:ton|ce que))\b/i.test(m)) return "unclear";
  return null;
}

/** "what should I practise before the test", "what do I revise next", "what should I work on" — they want study advice, not another question. */
export function asksWhatToPractise(message: string): boolean {
  const m = String(message || "");
  if (m.length > 240 || /^\s*\[/.test(m)) return false;
  return /\bwhat (?:should|do|can|would) (?:i|we) (?:practi[sc]e|revise|study|work on|focus on|review|do next|learn next)\b|\bwhat (?:to|else to) (?:practi[sc]e|revise|study|focus on)\b|\b(?:what|which) (?:topics?|parts?|things?) (?:should|do) i (?:practi[sc]e|revise|study|review)\b|\bquoi (?:réviser|travailler|revoir)\b|\bque (?:dois|devrais)-je (?:réviser|travailler)\b/i.test(m);
}
