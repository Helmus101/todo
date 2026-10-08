// THE ACTION SPACE — spec §19/§45: a closed set of teaching actions, logged with a reason so the agent's
// own behaviour is debuggable (never shown to the student).
//
// Deliberately NOT model-authored: asking the model to self-report {action, why, evidence, goal,
// expectedNext} on every turn would mean either a mandatory extra tool call (latency + cost on every
// single turn) or a free-text field the model could get lazy with. Instead this classifies what the turn
// ACTUALLY DID — which tools fired, what kind of board entry landed, how the reply is shaped — onto one
// TutorAction, for free, after the fact. `why` is a short mechanical trigger description, not a
// justification; `target`/`evidence`/`goal`/`expectedNext` stay unset in this version (see the plan's
// "explicitly deferred" section — populating those for real needs the model's own reasoning, which this
// module is deliberately not asking for).
import type { BoardEntry, TaskProblem, TaskObjective } from "../shared/types.ts";
import type { TutorAction, TutorDecisionShape } from "../shared/agentTypes.ts";

export interface TurnActionInputs {
  reply: string;
  /** Entries/problems/objectives CREATED OR CHANGED this turn only — ChatResult's own arrays, never the
   *  full current board (that would make every turn look like it touched everything). */
  newBoardEntries: BoardEntry[];
  newProblems: TaskProblem[];
  newObjectives?: TaskObjective[];
  /** The board as it stood BEFORE this turn — only consulted to tell ASK_QUESTION apart from ASK_FOLLOWUP
   *  (was there already an open question on the page?). */
  priorBoard?: BoardEntry[];
}

function hasOpenQuestion(board: BoardEntry[] | undefined): boolean {
  return !!board?.length && board.slice(-3).some((e) => e.kind === "question" || e.kind === "gap");
}

/** Classify what this turn actually did onto one TutorAction — see the module comment for why this is
 *  mechanical rather than model-authored. Checks run in a fixed priority order (a problem beats a board
 *  write, a board write beats a bare-reply read), so a turn that did several things still gets ONE
 *  primary action rather than an ambiguous pick. */
export function classifyTurnAction(input: TurnActionInputs): { action: TutorAction; why: string } {
  const { reply, newBoardEntries, newProblems, priorBoard } = input;

  if (newProblems.length) return { action: "CREATE_PROBLEM", why: "called CREATE_PROBLEM this turn" };

  const gap = newBoardEntries.find((e) => e.kind === "gap");
  if (gap) return { action: "CREATE_GAP", why: "wrote a WRITE_TO_BOARD entry with kind=gap" };

  const diagram = newBoardEntries.find((e) => e.kind === "diagram");
  if (diagram) {
    const ops = diagram.diagram || [];
    const allEquations = ops.length > 0 && ops.every((op) => op.op === "equation");
    return allEquations
      ? { action: "WRITE_EQUATION", why: "drew a diagram entry made entirely of 'equation' ops" }
      : { action: "CREATE_DIAGRAM", why: "called DRAW_ON_BOARD/GEOMETRY_ON_BOARD with real shapes" };
  }
  if (newBoardEntries.some((e) => e.kind === "graph")) {
    return { action: "CREATE_GRAPH", why: "called GRAPH_ON_BOARD this turn" };
  }
  // No literal bucket for an embedded interactive scene — closest existing action is CREATE_DIAGRAM
  // (both are "show, don't tell" board artifacts); revisit if a dedicated action is ever added.
  if (newBoardEntries.some((e) => e.kind === "interactive")) {
    return { action: "CREATE_DIAGRAM", why: "called CREATE_INTERACTIVE this turn (no dedicated action bucket yet)" };
  }

  const question = newBoardEntries.find((e) => e.kind === "question");
  if (question) {
    return hasOpenQuestion(priorBoard)
      ? { action: "ASK_FOLLOWUP", why: "wrote a board question while one was already open" }
      : { action: "ASK_QUESTION", why: "wrote a new board question" };
  }

  if (newBoardEntries.length) {
    return { action: "EXPLAIN", why: `wrote a board entry (kind=${newBoardEntries[0].kind || "note"}) with no more specific action match` };
  }

  const trimmed = reply.trim();
  if (/\?\s*$/.test(trimmed)) {
    return hasOpenQuestion(priorBoard)
      ? { action: "ASK_FOLLOWUP", why: "reply ends in a question while one was already open on the board" }
      : { action: "ASK_QUESTION", why: "reply ends in a question, no tool call this turn" };
  }
  if (trimmed.length > 0 && trimmed.length < 40) {
    return { action: "WAIT", why: "short, content-free reply (ack/encouragement) — nothing new to teach this turn" };
  }
  return { action: "EXPLAIN", why: "plain-text reply with no tool call and no trailing question" };
}

/** Build the full decision record (what TutorDecisionShape expects) from a turn's classification. */
export function buildTutorDecision(input: TurnActionInputs & { now: Date; taskId?: string; subject?: string }): TutorDecisionShape {
  const { action, why } = classifyTurnAction(input);
  return { at: input.now.toISOString(), taskId: input.taskId, subject: input.subject, action, why };
}

/** Cap on the decision log kept per profile — mirrors the other per-profile logs' sizing (a recent window
 *  for debugging, not a full history). */
export const TUTOR_DECISION_CAP = 40;

/** Append one decision, capped — same append-and-slice shape as recordBoardEvents (boardEvents.ts). */
export function recordTutorDecision(existing: TutorDecisionShape[] | undefined, decision: TutorDecisionShape): TutorDecisionShape[] {
  return [...(existing || []), decision].slice(-TUTOR_DECISION_CAP);
}
