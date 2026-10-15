// HOW MUCH HELP THIS TURN MAY GIVE — decided by code, never by the model's opinion of itself.
//
// Focusing before funnelling (HeyAristotle's protocol): when the student is moving, help stays light; each turn the
// support may rise by ONE level at most, so a hint never jumps straight to the answer. The exceptions are the ones a
// good human tutor makes: the student is lost, asks to start over, asks why or asks to be shown — or has been stuck
// for two turns — and then explaining (level 4) is allowed at once. A full worked example (level 5) needs a real
// request for one or a long struggle. A verified right step drops the level back to the bottom. Pure.
import type { TutorTeachingState, TutorTurnRecord } from "../../shared/types.ts";
import { MOVES, MOVE_SUPPORT, type Move } from "../../shared/tutorTurn.ts";

export interface PolicyInput {
  teaching?: TutorTeachingState;
  /** The student needs it explained now (lost, "start over", "explain", "write it", why, frustrated). */
  needsExplanation: boolean;
  asksWhy: boolean;
  /** "show me the whole solution", "give me an example", "just tell me". */
  asksForWorkedExample: boolean;
  /** Code verified their step or answer this turn. */
  verdict?: "correct" | "incorrect";
}

export interface Policy {
  maxSupport: number;
  explainAllowed: boolean;
  /** Moves allowed this turn, in support order. */
  allowed: Move[];
  /** Why the limit is what it is — shown to the model so it can choose well. */
  reason: string;
}

const WORKED_EXAMPLE = /\b(?:(?:full|whole|complete) (?:solution|working|answer)|worked example|(?:give|show) me an? example|show me how|just (?:tell|show) me|(?:solve|do) it (?:for me|with me)|montre[- ]moi (?:comment|la (?:solution|méthode))|un exemple|la solution compl[eè]te)\b/i;
export function asksForWorkedExample(message: string): boolean {
  return WORKED_EXAMPLE.test(String(message || ""));
}

export function supportPolicy(p: PolicyInput): Policy {
  const last = p.teaching?.lastSupport ?? 0;
  const stuck = Math.max(p.teaching?.stuckStreak ?? 0, p.teaching?.unproductive ?? 0);
  let max = p.verdict === "correct" ? 1 : Math.min(5, last + 1);
  let reason = p.verdict === "correct" ? "their step is verified right — help stays light, move them on" : `last turn was at level ${last}, so at most ${max} now`;
  let explainAllowed = false;
  if (p.needsExplanation || p.asksWhy) { max = Math.max(max, 4); explainAllowed = true; reason = p.asksWhy ? "they asked why — explain the reason" : "they're lost or asked to be shown — explain it plainly now"; }
  if (stuck >= 2 && p.verdict !== "correct") { max = Math.max(max, 4); explainAllowed = true; reason = `stuck ${stuck} turns — questions aren't working, teach the missing idea`; }
  if (p.asksForWorkedExample || stuck >= 4) { max = 5; explainAllowed = true; reason = p.asksForWorkedExample ? "they asked to see it worked through" : "a long struggle — show a worked example with different numbers"; }
  const allowed = MOVES.filter((m) => MOVE_SUPPORT[m] <= max);
  return { maxSupport: max, explainAllowed, allowed, reason };
}

/** The teaching-state fields this module owns, after a delivered move. `struggled` = a wrong attempt, a stuck/lost message, or a misconception this turn. A neutral turn (a greeting, a
 *  concept question) leaves the struggle count as it was; verified progress resets it. */
export function nextSupportState(prev: TutorTeachingState | undefined, delivered: { move: Move; verdict?: "correct" | "incorrect"; progressed: boolean; struggled: boolean }): Pick<TutorTeachingState, "lastSupport" | "unproductive"> {
  const before = prev?.unproductive ?? 0;
  return {
    lastSupport: delivered.verdict === "correct" || delivered.progressed ? 0 : MOVE_SUPPORT[delivered.move],
    unproductive: delivered.progressed ? 0 : delivered.struggled ? before + 1 : before,
  };
}

/** How the tutor should ADAPT this turn, worked out by code from what it already tried (the turn log) and how the student
 *  is doing — so a failed explanation changes angle instead of being repeated, and a student who is flying gets less. */
export function adaptationLines(log: TutorTurnRecord[] | undefined, now: { wrong: boolean; stuck: boolean }): string[] {
  const l = (log || []).slice(-6);
  const out: string[] = [];
  const last = l[l.length - 1];
  const teaching = (r: TutorTurnRecord) => ["explain", "worked_step", "worked_example", "hint_concept", "hint_procedure", "correct_error"].includes(r.move);
  if (last && teaching(last) && (now.wrong || now.stuck)) {
    const tried = [...new Set(l.filter(teaching).map((r) => r.angle).filter(Boolean))] as string[];
    out.push(`YOUR LAST ${last.move.replace(/_/g, " ").toUpperCase()} DID NOT LAND (they are ${now.wrong ? "still wrong" : "still stuck"}). Do NOT repeat it or say it louder: change the angle${tried.length ? ` (already used: ${tried.join(", ")})` : ""} — a picture, real numbers, an everyday analogy, a smaller piece, or a contrast with the wrong idea. Name what was hard to see before you re-explain. Set "angle" to the one you use.`);
  }
  const fast = l.slice(-2);
  if (fast.length === 2 && fast.every((r) => r.verdict === "correct" && r.support <= 1)) out.push("They are moving fast and getting it right alone: say less, skip the scaffolding, make the next step harder or ask why it works.");
  const tutorWords = l.reduce((n, r) => n + r.words, 0), theirWords = l.reduce((n, r) => n + r.studentWords, 0);
  if (l.length >= 3 && tutorWords > 10 * Math.max(theirWords, 8)) out.push("You are doing most of the talking: shorter turns, and get them to say the next step.");
  const rungs = l.filter((r) => r.support >= 4).length;
  if (rungs >= 2 && now.wrong) out.push("You have already explained twice and they still miss it: check a prerequisite with one easy question (diagnosis.prerequisite) rather than explaining the same thing again.");
  return out;
}
