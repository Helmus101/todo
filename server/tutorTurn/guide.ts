// RUNNING THE SESSION — what a good tutor does between questions: opens with a plan instead of "where do you want to
// start?", makes a right answer solid before moving on, and doesn't drop a half-finished topic because the student's
// attention drifted. Pure: it only reads the turn log, the history and the board, and returns lines for the facts block.
import type { TutorTurnRecord } from "../../shared/types.ts";

const SWITCH = /\b(?:let'?s do|can we do|lets? (?:go|move) (?:to|on)|actually|instead|switch(?: to)?|move on|something else|next topic|on (?:va|passe)|passons|plut[ôo]t|changeons)\b/i;
const DEEPENING = new Set(["probe_why", "practice", "recap", "worked_example"]);

export interface GuideInput {
  message: string;
  history: { role: "user" | "assistant"; text: string }[];
  log: TutorTurnRecord[] | undefined;
  /** This turn's step/answer was checked by code and is right. */
  correctNow: boolean;
  /** An exercise or a gap is still open on the board. */
  openWork: boolean;
  hasObjectives: boolean;
}

export function sessionGuide(i: GuideInput): string[] {
  const out: string[] = [];
  const log = (i.log || []).slice(-8);
  const studentTurns = i.history.filter((h) => h.role === "user").length;

  // 1. Open with a plan, never an open question.
  if (studentTurns <= 1 && !SWITCH.test(i.message) ) {
    out.push(`OPEN THE SITTING WITH A PLAN, don't ask "where do you want to start?": in two sentences say what you will cover today and why (their level and courses, their objectives, the upcoming test, what they did and what was shaky last time — see BACKGROUND and its memory), start on the first item, and end with ONE easy question or "ready?". ${i.hasObjectives ? "" : "They have no plan yet: add a plan op with 3–4 objectives. "}If they named a topic, honour it and plan around it.`);
  }

  // 2. Don't abandon a topic that isn't solid yet.
  const solidSteps = log.filter((r) => r.verdict === "correct" && r.support <= 2).length;
  const askedToSwitchBefore = i.history.filter((h) => h.role === "user").slice(-4, -1).some((h) => SWITCH.test(h.text));
  if (SWITCH.test(i.message) && studentTurns > 1 && (i.openWork || solidSteps < 2)) {
    out.push(askedToSwitchBefore
      ? "THEY ASKED TO SWITCH TOPICS AGAIN: do it now (a topic op for the new one), and say in a few words that you can come back to the parked topic later."
      : "THEY WANT TO SWITCH TOPICS but the current one is not solid yet: say in one short sentence that you'll come back to it, finish it with ONE more step or check (about a minute), then offer the switch. Don't refuse — if they ask again, switch.");
  }

  // 3. A right answer is the start of consolidating, not the signal to leave.
  if (i.correctNow) {
    const recentDeepening = log.slice(-3).some((r) => DEEPENING.has(r.move));
    out.push(recentDeepening
      ? "SOLID NOW (they got it right and you already tested why): name in a few words what they can do, then move on to the next piece of the plan."
      : "MAKE IT SOLID BEFORE MOVING ON: credit exactly what was right, then do ONE of — ask why that step works, give a variation with different numbers, or ask them to state the rule in their own words. Don't open a new topic or a new exercise this turn.");
  }

  // 4. Never ask for what is already on the board.
  out.push("Before you ask for a value or a fact, check the board: if it's already on a line (like r = 1), point at that line instead of asking for it, and ask the next thing.");
  return out;
}
