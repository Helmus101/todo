// SITUATION CARDS: guidance that matters only in a certain moment, handed to the tutor as a private note when that moment arrives, instead of
// sitting in the instructions of every call among sixty other rules. A card is a short text and a trigger over what the app already knows
// (the student's last words, the stuck count, the board). Cards that replace a section of the long tutor prompt reuse that section's own text
// (sectionOf), so nothing is written twice. Delivered once, then not again for a few turns (cooldown), as a note that triggers no reply of its own,
// so it shapes the NEXT turns. Pure: the page decides when to send, this decides what.
import { TUTOR_PROMPT } from "./tutorPrompt.ts";

export interface SituationState {
  /** The student's last turn (cleaned transcript). */
  student: string;
  /** The tutor's last turn. */
  tutor: string;
  /** How many student turns so far in this sitting. */
  turns: number;
}

export interface SituationCard { id: string; trigger: (s: SituationState) => boolean; text: string; /** student turns before it may fire again */ cooldown: number }

/** The text of one section of the long tutor prompt: from its header line to the next header line. */
export function sectionOf(header: string, full: string = TUTOR_PROMPT): string {
  const lines = full.split("\n");
  const isHeader = (l: string) => /^[A-Z][A-Z0-9 ,'&—()\/:.-]{11,}/.test(l) && !l.startsWith("- ");
  const at = lines.findIndex((l) => l.startsWith(header));
  if (at < 0) return "";
  let end = at + 1;
  while (end < lines.length && !isHeader(lines[end])) end++;
  return lines.slice(at, end).join("\n").trim();
}

const words = (s: string) => String(s || "").trim().split(/\s+/).filter(Boolean).length;

/** They name a method of their own ("I would take the cosine", "let's just solve it", "maybe I could square both sides"). */
export function namesOwnRoute(t: string): boolean {
  return /\b(?:i(?:'d| would| will| could|'ll)? (?:just )?(?:take|use|try|square|substitute|differentiate|integrate|expand|factori[sz]e|rearrange|solve|multiply|divide|set|plug|cross)|let(?:'?s| us) (?:just )?(?:solve|take|use|try|do|expand|square|work)|maybe (?:i|we) (?:could|can|should)|can (?:i|we) (?:just )?(?:use|try|take|solve))\b/i.test(String(t || ""));
}
/** They challenge the tutor, or say what is on the board is wrong. */
export function challengesTutor(t: string): boolean {
  return /\b(?:are you sure|you(?:'re| are) wrong|that(?:'s| is) (?:not|wrong|incorrect)|that'?s not right|you made a mistake|is that right\?|isn'?t it\b|you drew (?:it|that|the graph) wrong|that(?:'s| is) the opposite|no,? (?:wait|that)|wait,? (?:that|are|is))\b/i.test(String(t || ""));
}
/** "What do you mean?", "I don't understand what you asked". */
export function asksWhatYouMean(t: string): boolean {
  return words(t) <= 12 && /\b(?:what do you mean|what does that mean|i don'?t (?:understand|follow) (?:what|the question)|what are you asking|say that again|huh)\b/i.test(String(t || ""));
}
/** A fresh problem is being handed over: an instruction word and enough words to be a real problem. */
export function statesAProblem(t: string): boolean {
  return words(t) >= 14 && /\b(?:solve|find|show that|prove|calculate|determine|evaluate|sketch|given that|what is the|how many|express)\b/i.test(String(t || ""));
}
/** They are going over work they already did ("I just had a test", "a past paper question", "I got this wrong"). */
export function reviewsPastWork(t: string): boolean {
  return /\b(?:i just (?:had|did|took|sat)|(?:a|the|my) (?:test|exam|mock|quiz|past paper)|went over|go over|i got (?:this|that|it) wrong|marked wrong|from (?:my|the) (?:test|exam|paper))\b/i.test(String(t || ""));
}
/** They give candidate values that came out of squaring or a quadratic ("x equals plus or minus a half", "so x squared is a quarter"). */
export function reachesCandidates(t: string): boolean {
  return /\b(?:plus or minus|±|x squared (?:is|equals)|two (?:solutions|roots|values)|so x (?:is|equals))\b/i.test(String(t || ""));
}
/** They ask for the result outright. */
export function asksForAnswer(t: string): boolean {
  return /\b(?:just (?:tell|give) me|what(?:'s| is) the answer|give me the answer|tell me the answer|we'?ve been over|can you just do it)\b/i.test(String(t || ""));
}
/** An exam, a mock or a test is coming. */
export function mentionsExam(t: string): boolean {
  return /\b(?:exam|mock|test|paper|ia\b|deadline)\b.*\b(?:tomorrow|next week|monday|friday|soon|coming|on \w+day|in \d+ days?)\b|\b(?:tomorrow|next week)\b.*\b(?:exam|mock|test|paper)\b/i.test(String(t || ""));
}
/** Too easy, or they want a stretch. */
export function wantsHarder(t: string): boolean {
  return /\b(?:too easy|boring|give me something (?:hard|harder)|i'?m aiming for a (?:6|7)|properly hard|challenge me|harder one)\b/i.test(String(t || ""));
}

const EXAM = sectionOf("EXAM READINESS");
const PITCH = sectionOf("PITCH IT HARD ENOUGH");

export const SITUATION_CARDS: SituationCard[] = [
  { id: "own-route", cooldown: 4, trigger: (s) => namesOwnRoute(s.student),
    text: "They named their own method. Follow it: ask them to carry it out, step by step, and look at what they write. Steer to your route only if theirs cannot work, and then say exactly why in one sentence." },
  { id: "challenge", cooldown: 3, trigger: (s) => challengesTutor(s.student),
    text: "They are challenging you or saying something is wrong. Before you answer, recompute it yourself, out loud and briefly. If they are right, say so plainly and fix it (the board too, with a replacing write). If you are right, show the one line that proves it. Do not say \"I'm sure\"." },
  { id: "rephrase", cooldown: 2, trigger: (s) => asksWhatYouMean(s.student),
    text: "\"What do you mean?\" means they lost your last sentence. Say it another way in fewer words, or ask which word lost them. Do not repeat the instruction and do not give the next one." },
  { id: "new-problem", cooldown: 6, trigger: (s) => s.turns <= 2 || statesAProblem(s.student),
    text: "A problem has been handed to you. Write it as a given, with every condition or domain they stated, in the same line. Then ask how they would start, or look at how they already started. Do not choose the route, do not give the first step, and do not state any result." },
  { id: "review", cooldown: 8, trigger: (s) => reviewsPastWork(s.student),
    text: "They are going over work they already did. It is still their work: ask where they got stuck or what they wrote, and let them redo that part. Do not solve it for them, and do not hand over the result because the sitting is over." },
  { id: "check-candidates", cooldown: 5, trigger: (s) => reachesCandidates(s.student),
    text: "They have candidate values. If the equation was squared, or has a restricted domain or interval, each candidate must be checked in the ORIGINAL equation before it is called a solution. Ask them to do the check; do not do it for them and do not say which one works." },
  { id: "asks-answer", cooldown: 3, trigger: (s) => asksForAnswer(s.student),
    text: "They asked for the answer. That is not permission while they are working on it. Be warm and short: say you will not take it from them, ask where exactly they are stuck, and offer one smaller question. Offer a worked solution only if they are reviewing finished work and ask for it clearly." },
  ...(EXAM ? [{ id: "exam", cooldown: 20, trigger: (s: SituationState) => mentionsExam(s.student), text: EXAM } as SituationCard] : []),
  ...(PITCH ? [{ id: "pitch", cooldown: 12, trigger: (s: SituationState) => wantsHarder(s.student), text: PITCH } as SituationCard] : []),
];

/** The cards that fire for this turn, skipping any delivered within its cooldown. `lastAt` maps card id to the student-turn number it was last sent. Pure. */
export function dueCards(state: SituationState, lastAt: Record<string, number>): SituationCard[] {
  return SITUATION_CARDS.filter((c) => c.trigger(state) && (lastAt[c.id] === undefined || state.turns - lastAt[c.id] >= c.cooldown)).slice(0, 2);
}

/** The private note for the tutor, or "". Cards shape the next turns; they trigger no reply of their own. */
export function situationNote(cards: SituationCard[]): string {
  if (!cards.length) return "";
  return `Private note for you, not from the student, about the situation you are in now (it applies until they move on; do not mention it): ${cards.map((c) => c.text).join(" ")}`;
}
