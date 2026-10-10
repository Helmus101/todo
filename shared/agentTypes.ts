// Shared agent-layer types — the shapes that the adaptive-tutor modules (server/studentModel.ts,
// server/conceptGraph.ts, server/sessionState.ts, server/boardEvents.ts, server/actionSpace.ts) persist on the
// profile and that the client's own views read back.
//
// These live in `shared` rather than in the server modules for one reason: the client imports shared/types.ts,
// so a `Profile` field typed against a server module would drag server code into the browser bundle. Declaring
// the shapes here keeps one definition, no cycle, and a client bundle that stays server-free.
//
// Pure types + pure constant tables only. No I/O, no functions that read a clock.

/* ── the persistent student model (server/studentModel.ts) ──────────────────────────────────────────── */

/** How a piece of evidence was produced. Ordered loosest → strictest, which is also how mastery weights them. */
export type EvidenceKind =
  | "mistake"
  | "misconception"
  | "solved-after-explanation"
  | "solved-after-partial"
  | "solved-after-hint"
  | "solved-unaided"
  | "self-corrected"
  | "recall-miss"
  | "recall"
  | "transfer-fail"
  | "transfer-success"
  | "objective-done";

/** Mastery weight of each evidence kind — the SINGLE table deciding how much a signal moves mastery. The
 *  spec §21 progression is visible in this ordering: demonstrating something after being TOLD it is weak
 *  evidence, doing it unaided is strong, applying it in a new context (transfer) is strongest of all. */
export const EVIDENCE_WEIGHT: Record<EvidenceKind, number> = {
  "misconception": 0.04,
  "mistake": 0.08,
  "recall-miss": 0.12,
  "transfer-fail": 0.2,
  "solved-after-explanation": 0.3,
  "recall": 0.45,
  "solved-after-partial": 0.45,
  "solved-after-hint": 0.62,
  "objective-done": 0.72,
  "solved-unaided": 0.85,
  "self-corrected": 0.9,
  "transfer-success": 1,
};

/** The kinds that count as a SETBACK — mastery is pulled down toward their (low) weight instead of up. */
export const EVIDENCE_SETBACK: EvidenceKind[] = ["mistake", "misconception", "recall-miss", "transfer-fail"];

/** An observed misconception — a HYPOTHESIS, not a verdict. `confidence` is decayed at read time so a belief
 *  formed a term ago cannot keep dominating the tutor's read of who this student is today. */
export interface ConceptMisconception {
  text: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  confidence: number;
  evidence: string[];
  retiredAt?: string;
}

/** A recurring CALCULATION slip — tracked separately from a misconception because the fix is different (a
 *  habit/checklist rather than re-teaching the idea). */
export interface ConceptError {
  text: string;
  count: number;
  lastSeen: string;
}

/** One moment that changed the model — the audit trail behind §30's "every belief has evidence". */
export interface ConceptEvidence {
  at: string;
  kind: EvidenceKind;
  detail?: string;
}

/** Everything Otto believes about this student on ONE concept. */
export interface ConceptRecord {
  key: string;
  label: string;
  subject?: string;
  /** 0-1, EWMA over the evidence stream. */
  mastery: number;
  /** 0-1: how sure OTTO is of `mastery`. Kept separate from mastery so "no data yet" never reads as "bad at
   *  this" — the same honesty rule subjectMastery follows by returning null instead of a fabricated 0%. */
  confidence: number;
  attempts: number;
  unaided: number;
  hinted: number;
  partial: number;
  explained: number;
  transferAttempts: number;
  transferWins: number;
  recalls: number;
  recallWins: number;
  misconceptions: ConceptMisconception[];
  commonErrors: ConceptError[];
  strengths: string[];
  evidence: ConceptEvidence[];
  lastDemonstrated?: string;
  nextReview?: string;
  updatedAt: string;
  /** The extensibility escape hatch: new scalars land here until they've earned a real field. */
  extras: Record<string, number | string>;
}

export interface StudentModelShape {
  concepts: Record<string, ConceptRecord>;
  updatedAt: string;
}

export const CONCEPT_CAP = 60;
export const EVIDENCE_CAP = 6;
export const MISCONCEPTION_CAP = 4;
export const MISCONCEPTION_EVIDENCE_CAP = 4;
export const COMMON_ERROR_CAP = 6;
/** Half-life of a misconception's confidence, in days. */
export const MISCONCEPTION_HALF_LIFE_DAYS = 45;
/** Below this decayed confidence a misconception stops steering the lesson (it stays on the record). */
export const MISCONCEPTION_LIVE_THRESHOLD = 0.15;
/** EWMA weight of the newest evidence against existing mastery — one moment can't erase a term. */
export const MASTERY_EWMA = 0.25;
/** Mastery below this reads as "shaky" to both the prompt and the graph (they must never disagree). */
export const WEAK_MASTERY = 0.45;
/** Below this much evidence, a reading is "we don't know yet" rather than a verdict. */
export const UNKNOWN_CONFIDENCE = 0.25;

/* ── the knowledge graph (server/conceptGraph.ts) ───────────────────────────────────────────────────── */

export interface ConceptNode {
  id: string;
  label: string;
  subject: string;
  /** Prerequisite concept ids — what must be in place BEFORE this one. */
  prereqs: string[];
  kind: "spine" | "discovered";
  source?: string;
  aliases?: string[];
}

export interface ConceptGraphShape {
  nodes: Record<string, ConceptNode>;
  updatedAt: string;
}

export const GRAPH_DISCOVERED_CAP = 120;
export const PREREQ_MAX_DEPTH = 3;

/* ── the application-owned session state (server/sessionState.ts) ───────────────────────────────────── */

/** One recorded action in a session's recent history. */
export interface SessionAction {
  at: string;
  kind: "student-message" | "board-write" | "board-answer" | "hint" | "answer-seek" | "problem" | "objective" | "decision";
  detail: string;
}

/** Where a session had got to. APP-OWNED (spec §18: "the LLM should not be responsible for maintaining this
 *  state by itself") — rebuilt deterministically from what the app already observes, then handed to the model
 *  as read-only context. `strategy`/`pace`/`nextRecommendedAction` are strings rather than a union here on
 *  purpose: the canonical move/pace enums live in server/tutorPolicy.ts, and duplicating them in shared would
 *  drift. The closed ACTION space the model must choose from is server-side and validated per turn
 *  (server/actionSpace.ts). */
export interface TutorSessionStateShape {
  taskId: string;
  updatedAt: string;
  startedAt: string;
  objective?: string;
  /** The concept the session is currently about, if the app can name it. */
  concept?: string;
  /** The specific sub-problem in play right now (the newest gap or open problem on the board, usually). */
  subproblem?: string;
  mastery?: number | null;
  confidence?: number;
  liveMisconception?: string;
  strategy?: string;
  pace?: string;
  /** The high-water mark of the hint ladder used in THIS session (0-6) — never decreases, which is what makes
   *  "they've already been given the direction, don't re-derive it" answerable. */
  hintRung: number;
  turns: number;
  hintRequests: number;
  answerSeeks: number;
  unaidedSuccesses: number;
  /** Interventions Otto has actually issued (a hint rung >= 2, or a corrective nudge). */
  interventions: number;
  /** 0-1, derived from unaided solves vs hints/answer-seeks across this session. */
  independence: number;
  /** 0-1 frustration read, from the existing reaction/short-message/repeat signals. */
  frustration: number;
  boardRichness: number;
  recentActions: SessionAction[];
  nextRecommendedAction?: string;
  /** Help level (0-6) already used on the CURRENT sub-problem — resets when a new question/problem starts
   *  (server/tutorBrain.ts). The policy only lets Otto climb one rung past it at a time. */
  levelNow?: number;
  /** Concept keys already given their retrieval check this session. */
  retestDone?: string[];
  /** What the student said they want and how long they have (spec §36/§37). */
  goalType?: string;
  minutes?: number;
  /** The model's last plan, so the next turn can check "did what I expected happen?". */
  lastPlan?: { action: string; why?: string; expectedNext?: string; diagnosis?: string };
  /** The tutor's running LEDGER for the problem in play: facts it has verified ("TRUE: …") and student claims it has
   *  judged wrong ("WRONG: …"). Fed back every turn so a verdict is never silently contradicted. */
  ledger?: string[];
  /** The hidden QUICKEST route to the answer for the problem in play (3-6 short ideas) and whether they last left it. */
  route?: string[];
  offRoute?: boolean;
}

export const SESSION_CAP = 8;
export const SESSION_ACTION_CAP = 12;

/* ── the board event stream (server/boardEvents.ts) ─────────────────────────────────────────────────── */

export type BoardEventKind =
  | "otto-wrote"
  | "student-wrote"
  | "student-answered"
  | "student-answered-wrong"
  | "erased"
  | "rewrote"
  | "objective-done"
  | "hint-requested"
  | "problem-created"
  | "problem-solved";

export interface BoardEventShape {
  at: string;
  kind: BoardEventKind;
  entryId?: string;
  detail: string;
}

export const BOARD_EVENT_CAP = 80;

/* ── the action space (server/actionSpace.ts) ──────────────────────────────────────────────────────── */

/** The closed set of teaching actions the agent may choose from (spec §19). The model picks one per turn; the
 *  application validates it against the session state before the choice is honoured. */
export const TUTOR_ACTIONS = [
  "ASK_QUESTION",
  "ASK_FOLLOWUP",
  "GIVE_HINT",
  "GIVE_TARGETED_HINT",
  "EXPLAIN",
  "SHOW_EXAMPLE",
  "CREATE_PROBLEM",
  "MODIFY_PROBLEM",
  "CREATE_DIAGRAM",
  "CREATE_GRAPH",
  "WRITE_EQUATION",
  "HIGHLIGHT",
  "POINT_TO_OBJECT",
  "CREATE_GAP",
  "ASK_STUDENT_TO_DRAW",
  "ASK_STUDENT_TO_EXPLAIN",
  "RETEST",
  "CHANGE_CONCEPT",
  "STEP_BACK_PREREQUISITE",
  "MOVE_FORWARD",
  "WAIT",
] as const;
export type TutorAction = typeof TUTOR_ACTIONS[number];

/** One agent decision, kept for debuggability (spec §45). Never shown to the student. */
export interface TutorDecisionShape {
  at: string;
  taskId?: string;
  subject?: string;
  action: TutorAction;
  target?: string;
  why: string;
  evidence?: string;
  goal?: string;
  expectedNext?: string;
  /** Set when the app overrode the model's first choice — with the app's reason. */
  correctedFrom?: TutorAction;
  correctReason?: string;
}

export const DECISION_CAP = 40;
