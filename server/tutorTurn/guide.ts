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
  /** The exercise's final answer was reached (code-checked) or every exercise is solved. */
  finalReached?: boolean;
  /** From Settings: year/grade, programme, courses — empty when unknown. */
  level?: string;
}

const drewMarker = (m: string) => /\[(?:What I wrote\/drew on the board|Ce que j'ai écrit\/dessiné sur le tableau)\s*:/i.test(m);

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

  // 2b. They pushed back on a question: accept it, don't ask another about the same step.
  const PUSHBACK = /\b(?:that'?s just|that is just|it'?s just|it is just|but we (?:are|were) (?:asked|looking)|we'?re asked|we are asked|i (?:already|just) (?:did|said|told|gave)|just tell me|why does that matter|c'?est juste|on (?:nous )?demande|je l'?ai d[ée]j[àa])\b/i;
  const pushedBack = PUSHBACK.test(i.message);
  if (pushedBack) out.push("THEY PUSHED BACK on your question. Accept their answer in a few words, answer their point (\"yes, the question asks for X and you have it\"), and move on to the next piece or finish. Do NOT ask another why, unit or definition question about this step.");
  // 2c. Pasted material: pick one question, name it, put it on the board.
  const pasted = i.message.length > 600 || (i.message.match(/\?/g) || []).length >= 3 || /\n\s*(?:[A-D][.)]|\d+[.)])\s/.test(i.message);
  if (pasted && !drewMarker(i.message)) out.push("THEY PASTED MATERIAL (a quiz, a worksheet…). Choose ONE question from it and SAY which one by quoting its first words; put it on the board (a topic op, the givens as steps) and ask the first step. Never say \"that question\" or \"the car problem\" without quoting it. If it holds several questions, add a plan op listing them in the order you will do them, and work them one at a time.");
  // 3. A right answer is the start of consolidating, not the signal to leave.
  if (i.correctNow && !pushedBack) {
    const recentDeepening = log.slice(-3).some((r) => DEEPENING.has(r.move));
    const askedWhyRecently = log.slice(-6).some((r) => r.move === "probe_why");
    if (i.finalReached) out.push("THE EXERCISE IS DONE: confirm the result in a few words" + (askedWhyRecently ? ", then offer" : ", add one sentence on the key idea, then offer") + " a variation with new numbers that is a step harder, or the next item of the plan. No further questions about how they got there.");
    else out.push(recentDeepening
      ? "SOLID NOW (they got it right and you already tested why): name in a few words what they can do, then move on to the next piece of the plan."
      : "MAKE IT SOLID BEFORE MOVING ON: credit exactly what was right, then do ONE of — ask why that step works, give a variation with different numbers, or ask them to state the rule in their own words. Don't open a new topic or a new exercise this turn.");
  }

  // 3b. A drawing came with the message: react to what is really in it.
  const drew = drewMarker(i.message);

  if (drew) out.push("THEY DREW OR WROTE ON THE BOARD (an image reader described it after the bracket; it can misread, so treat it as likely, not certain). Respond to the SPECIFIC features: say in one sentence what you see ('a curve with a vertical dashed line at x = 1 and …'), compare it with the problem and the verified solution (asymptote positions, intercepts, branches, labels), name what is right and the first thing that is off, then ask one question about that spot or mark it. Never say a sketch is good without checking it; if the reading looks implausible or low-confidence, say what you can make out and ask them to confirm.");
  // 4. Questions at THEIR level, guided by the board, rising while they succeed.
  const unaided = log.slice(-3);
  const flying = unaided.length >= 3 && unaided.every((r) => r.verdict === "correct" && r.support <= 1);
  out.push(`DIFFICULTY: pitch every question at ${i.level ? `their level (${i.level})` : "the level the student has shown so far"}, not below it. A question they could answer by reading one line off the board, or in a single obvious step, is TOO EASY — ask for two or three connected steps, a transfer to a new situation, a limit or special case, or the reason it works. Open the sitting with a question at their level, not a warm-up.${flying ? " They have answered the last three alone and right: make the next question clearly HARDER than any so far." : ""}`);
  out.push("BUILD QUESTIONS FROM THE BOARD: the next question extends what is on the board now — change a parameter, reverse the problem, ask for a limit case or what breaks — so the board and your questions are one thread, never a disconnected drill.");
  // 5. Never ask for what is already on the board.
  out.push("Before you ask for a value or a fact, check the board: if it's already on a line (like r = 1), point at that line instead of asking for it, and ask the next thing.");
  return out;
}
