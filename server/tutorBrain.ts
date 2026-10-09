// THE TUTOR BRAIN — the decision loop of spec §2: Observe → Interpret → Diagnose → Decide → Teach → (student acts)
// → Observe → Update → Adapt.
//
// Division of labour (spec §20):
//  · the MODEL interprets, diagnoses and chooses — every turn it writes a hidden <plan>{…}</plan> before its reply
//    (no extra round trip, no extra latency): what it observed, its diagnosis with a confidence, the concept, the
//    ACTION it picks from the closed action space, the hint LEVEL, why, what it expects next, and the evidence the
//    student's last move gives about the concept;
//  · the APPLICATION owns everything that must not drift: the per-turn pedagogical POLICY (how much help is allowed
//    right now, anti-dependence, when to wait, when to step back to a prerequisite, when a retrieval check or a
//    transfer question is due), VALIDATION of the model's plan against that policy (a violating plan gets one
//    corrective round), and every UPDATE (session state, the evidence-based student model, the concept graph, the
//    decision log). The model never writes state directly.
//
// Pure functions only (clock passed in), so every rule here is unit-tested in tests/tutor-sim.mjs.
import { TUTOR_ACTIONS, type TutorAction, type EvidenceKind, type TutorSessionStateShape, type ConceptRecord, type TutorDecisionShape } from "../shared/agentTypes.ts";
import type { BoardEntry } from "../shared/types.ts";
import { stuckStreak, reactionTo, asksToMoveOn } from "./tutorAdapt.ts";
import { conceptKey, findConcept, recordConceptEvidence, liveMisconceptions, independentSuccess, emptyStudentModel, type StudentModel } from "./studentModel.ts";
import { matchSpine, weakestPrereq, mergeDiscovered, prereqChain, type ConceptGraph, type StepBack } from "./conceptGraph.ts";

/* ── the plan the model writes each turn ──────────────────────────────────────────────────────────────── */

export const DIAGNOSES = ["none", "knowledge-gap", "misconception", "careless", "procedural", "prerequisite", "dependency", "unclear"] as const;
export type Diagnosis = (typeof DIAGNOSES)[number];
export const GOAL_TYPES = ["understand", "homework", "exam", "mastery", "review", "debug", "learn"] as const;
export type GoalType = (typeof GOAL_TYPES)[number];
const PLAN_EVIDENCE: EvidenceKind[] = ["mistake", "misconception", "solved-after-explanation", "solved-after-partial", "solved-after-hint", "solved-unaided", "self-corrected", "recall-miss", "recall", "transfer-fail", "transfer-success"];

export interface TutorPlan {
  observe?: string;
  diagnosis?: { type: Diagnosis; hypothesis?: string; confidence?: number };
  concept?: string;
  prerequisite?: string;
  action: TutorAction;
  level?: number;
  target?: string;
  why?: string;
  expectedNext?: string;
  evidence?: { kind: EvidenceKind; detail?: string };
  studentStep?: { text: string; status: "correct" | "incorrect" | "partial" };
  goal?: { type?: GoalType; minutes?: number };
  objective?: string;
  /** Cumulative verified facts / judged claims for the problem in play (see PLAN_PROTOCOL). */
  ledger?: string[];
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const str = (v: unknown, cap: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, cap) : "");

/** Validate whatever the model wrote into a plan. Unknown fields are dropped, enums enforced, numbers clamped. */
export function normalizePlan(raw: unknown): TutorPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const action = String(r.action || "").toUpperCase().replace(/[\s-]+/g, "_") as TutorAction;
  if (!(TUTOR_ACTIONS as readonly string[]).includes(action)) return null;
  const plan: TutorPlan = { action };
  const lvl = Number(r.level);
  if (Number.isFinite(lvl)) plan.level = Math.max(0, Math.min(6, Math.round(lvl)));
  for (const k of ["observe", "concept", "prerequisite", "target", "why", "objective"] as const) { const v = str(r[k], k === "why" || k === "observe" ? 300 : 120); if (v) (plan as any)[k] = v; }
  const exp = str(r.expected_next ?? r.expectedNext, 200); if (exp) plan.expectedNext = exp;
  const d = r.diagnosis;
  if (d && typeof d === "object" && (DIAGNOSES as readonly string[]).includes(String(d.type))) {
    const c = Number(d.confidence);
    plan.diagnosis = { type: d.type, ...(str(d.hypothesis, 240) ? { hypothesis: str(d.hypothesis, 240) } : {}), ...(Number.isFinite(c) ? { confidence: clamp01(c > 1 ? c / 100 : c) } : {}) };
  }
  const ev = r.evidence;
  if (ev && typeof ev === "object" && PLAN_EVIDENCE.includes(ev.kind)) plan.evidence = { kind: ev.kind, ...(str(ev.detail, 240) ? { detail: str(ev.detail, 240) } : {}) };
  const st = r.student_step ?? r.studentStep;
  if (st && typeof st === "object" && str(st.text, 300) && ["correct", "incorrect", "partial"].includes(st.status)) plan.studentStep = { text: str(st.text, 300), status: st.status };
  if (Array.isArray(r.ledger)) { const l = r.ledger.map((x: unknown) => str(x, 140)).filter(Boolean).slice(0, 10); if (l.length) plan.ledger = l; }
  const g = r.goal;
  if (g && typeof g === "object") {
    const type = (GOAL_TYPES as readonly string[]).includes(String(g.type)) ? (g.type as GoalType) : undefined;
    const minutes = Number(g.minutes);
    if (type || (Number.isFinite(minutes) && minutes > 0)) plan.goal = { ...(type ? { type } : {}), ...(Number.isFinite(minutes) && minutes > 0 ? { minutes: Math.min(600, Math.round(minutes)) } : {}) };
  }
  return plan;
}

const PLAN_RE = /<plan>([\s\S]*?)<\/plan>/i;
/** Pull the hidden plan out of a model reply and return the reply WITHOUT it. A malformed plan is dropped (the
 *  student never sees plan text either way); an unterminated `<plan>` at the very start is also stripped. */
export function extractPlan(text: string): { plan: TutorPlan | null; reply: string } {
  const src = String(text || "");
  const m = PLAN_RE.exec(src);
  if (!m) {
    // A cut-off plan (the model ran out of tokens mid-plan) — never show JSON to a student.
    if (/^\s*<plan>/i.test(src)) return { plan: null, reply: src.replace(/^\s*<plan>[\s\S]*$/i, "").trim() };
    return { plan: null, reply: src };
  }
  let plan: TutorPlan | null = null;
  const body = m[1].trim().replace(/^```(?:json)?|```$/g, "").trim();
  try { plan = normalizePlan(JSON.parse(body)); } catch { plan = null; }
  return { plan, reply: (src.slice(0, m.index) + src.slice(m.index + m[0].length)).replace(/^\s+/, "").trim() };
}

/* ── how much help each action is ─────────────────────────────────────────────────────────────────────── */

/** Spec §6's ladder: 0 open question · 1 directional · 2 narrow / point at it · 3 hint · 4 partial structure (a gap)
 *  · 5 partial solution / worked parallel example · 6 explanation. Board/visual actions carry no level of their
 *  own — they take the level the plan declares (a diagram can be a level-0 prompt or a level-6 explanation). */
export const ACTION_LEVEL: Partial<Record<TutorAction, number>> = {
  ASK_QUESTION: 0, ASK_STUDENT_TO_EXPLAIN: 0, ASK_STUDENT_TO_DRAW: 0, RETEST: 0, WAIT: 0,
  ASK_FOLLOWUP: 1, HIGHLIGHT: 2, POINT_TO_OBJECT: 2,
  GIVE_HINT: 3, GIVE_TARGETED_HINT: 3, CREATE_GAP: 4, SHOW_EXAMPLE: 5, EXPLAIN: 6,
};
export function effectiveLevel(plan: TutorPlan): number {
  return Math.max(ACTION_LEVEL[plan.action] ?? 0, plan.level ?? 0);
}

/* ── the application's pedagogical policy ─────────────────────────────────────────────────────────────── */

export type TimeMode = "rush" | "normal" | "deep";
export interface TutorPolicy {
  /** The most help Otto may give THIS turn (0-6). */
  maxLevel: number;
  /** The student is asking for the answer without having tried — ask for their attempt first. */
  askAttemptFirst: boolean;
  /** The student is mid-work and making progress: the right move is to say very little and let them continue. */
  waitOk: boolean;
  timeMode: TimeMode;
  concept?: { key: string; label: string; record?: ConceptRecord };
  stepBack?: StepBack;
  retest?: { key: string; label: string };
  transfer?: { label: string };
  graduate?: boolean;
  dependence?: boolean;
  /** Short, ranked recommendations — the app's read, which the model weighs (it still decides). */
  recommend: string[];
}

export interface PolicyInput {
  message: string;
  history: { role: string; text: string }[];
  state: TutorSessionStateShape;
  model?: StudentModel;
  graph?: ConceptGraph;
  subject?: string;
  board?: BoardEntry[];
  now: Date;
}

const ANSWER_SEEK = /\b(?:(?:just\s+)?(?:give|tell|show)\s+me\s+(?:the\s+)?(?:answer|solution|result)|what(?:'s| is)\s+the\s+(?:answer|solution)|(?:the\s+)?answer\s+please|can you (?:just )?(?:solve|do) (?:it|this)|solve (?:it|this) for me|donne(?:-|\s)?moi la (?:réponse|solution)|c['’]est quoi la réponse|quelle est la réponse|fais(?:-|\s)?le pour moi)\b/i;
const EXPLAIN_ASK = /\b(?:explain|teach me|what (?:is|are|does)|how does|i don['’]?t (?:understand|get) (?:what|why|how)|explique|c['’]est quoi|comment (?:ça marche|fonctionne))\b/i;
const MATHY = /[0-9=+\-*/^√π]/;

/** Has the student actually TRIED the current sub-problem? Any substantive student contribution since Otto's last
 *  question counts — an attempt, a step, a wrong answer, a drawing. */
export function attemptedSinceLastQuestion(message: string, history: { role: string; text: string }[]): boolean {
  const isAttempt = (t: string) => {
    const s = t.trim();
    if (/^\[(?:Exercise|Exercice)\]/.test(s) || /^\[(?:What I wrote|Ce que j['’]ai écrit)/.test(s) || /Here's what I drew|Voici ce que j'ai dessiné/.test(s)) return true;
    // "I got 4.9 but the book says 2.4, just tell me" IS an attempt — only a bare answer request isn't.
    const rest = s.replace(ANSWER_SEEK, " ").trim();
    if (ANSWER_SEEK.test(s) && !(MATHY.test(rest) && rest.split(/\s+/).length >= 4)) return false;
    return (MATHY.test(s) && s.split(/\s+/).length >= 2) || s.split(/\s+/).length >= 7;
  };
  if (isAttempt(message)) return true;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role === "assistant" && /\?\s*$/.test(h.text.trim())) break;
    if (h.role === "user" && isAttempt(h.text)) return true;
  }
  return false;
}

/** Resolve the concept a turn is about: the plan's own label first, then the session's, mapped onto the graph's
 *  curated spine when the words match (so prerequisites are real), else a stable discovered key. */
export function resolveConcept(label: string | undefined, graph: ConceptGraph | undefined, subject?: string): { key: string; label: string; nodeId?: string } | null {
  const l = str(label, 120);
  if (!l) return null;
  if (graph) {
    const hit = matchSpine(graph, l, { limit: 1 })[0] || matchSpine(graph, l, { subject, limit: 1 })[0];
    if (hit) return { key: conceptKey(hit.label), label: hit.label, nodeId: hit.id };
    const disc = Object.values(graph.nodes).find((n) => conceptKey(n.label) === conceptKey(l));
    if (disc) return { key: conceptKey(disc.label), label: disc.label, nodeId: disc.id };
  }
  return { key: conceptKey(l), label: l };
}

export function timeModeOf(state: TutorSessionStateShape): TimeMode {
  const goal = (state as any).goalType as GoalType | undefined;
  const minutes = (state as any).minutes as number | undefined;
  if ((minutes && minutes <= 30) || goal === "review") return "rush";
  if (goal === "exam" && minutes && minutes <= 90) return "rush";
  if (goal === "mastery" || goal === "learn" || (minutes && minutes >= 120)) return "deep";
  return "normal";
}

/** The policy for THIS turn. Deterministic: the same inputs always give the same answer. */
export function computePolicy(input: PolicyInput): TutorPolicy {
  const { message, history, state, model, graph, subject, now } = input;
  const s = state as TutorSessionStateShape & { levelNow?: number; retestDone?: string[]; subproblemAttempts?: number };
  const stuck = stuckStreak(message, history);
  const reaction = reactionTo(message, history);
  const tried = attemptedSinceLastQuestion(message, history);
  const seeking = ANSWER_SEEK.test(message);
  const timeMode = timeModeOf(state);
  const recommend: string[] = [];

  // ── how much help is allowed (minimum necessary assistance, spec §7) ──
  // Climb ONE rung past where this sub-problem already is; climb faster only on genuine evidence that the smaller
  // help didn't work (consecutive stuck turns), real frustration, or a hard time limit.
  const levelNow = typeof s.levelNow === "number" ? s.levelNow : 0;
  let maxLevel = levelNow + 1;
  if (stuck >= 2) maxLevel += 1;
  if (stuck >= 3) maxLevel += 1;
  if ((state.frustration || 0) > 0.55) maxLevel += 1;
  if (timeMode === "rush") maxLevel += 1;
  // A plain request to learn a NEW idea ("what is X?", "explain Y") may start at a short mini-explanation — the
  // spec is explicit that Socratic ≠ never explaining; you can't draw out what was never taught.
  if (EXPLAIN_ASK.test(message) && !MATHY.test(message)) maxLevel = Math.max(maxLevel, timeMode === "deep" ? 3 : 5);
  maxLevel = Math.max(1, Math.min(6, maxLevel));

  // ── anti-dependence (spec §8) ──
  const independence = state.independence ?? 0.6;
  const earnedTrust = independence >= 0.8 && state.turns >= 10 && (state.unaidedSuccesses || 0) >= 3;
  let askAttemptFirst = false;
  if (seeking && !tried && !earnedTrust) {
    askAttemptFirst = true;
    maxLevel = Math.min(maxLevel, 1);
    recommend.push("They asked for the answer without trying. Don't give it, and don't lecture: ask to see what they've tried or the first step they'd take (one short, friendly line).");
  } else if (seeking && tried) {
    recommend.push("They're asking for the answer after a real attempt: work from THEIR attempt — point at the exact step that breaks, one rung of help, never the final value.");
  }
  const dependence = independence < 0.35 && state.turns >= 4;
  if (dependence) recommend.push(`Independence is low (${Math.round(independence * 100)}%): give LESS help than feels natural — hand one small step back for them to do alone.`);

  // ── attention: is intervening even right (spec §15/16/39) ──
  const waitOk = !seeking && stuck === 0 && reaction.label === "attempt" && !/\?/.test(message) && tried;
  if (waitOk) recommend.push("They're working and moving forward: if the step is right, say very little (a few words) and let them continue — don't teach just because you can. Only step in if the step is wrong AND they're about to build on it.");

  // ── concept, prerequisites, retrieval, transfer ──
  const resolved = resolveConcept(state.concept, graph, subject);
  const record = resolved ? findConcept(model, resolved.key) || findConcept(model, resolved.label) : undefined;
  const policy: TutorPolicy = { maxLevel, askAttemptFirst, waitOk, timeMode, dependence, recommend, ...(resolved ? { concept: { key: resolved.key, label: resolved.label, ...(record ? { record } : {}) } } : {}) };

  if (graph && resolved?.nodeId && (stuck >= 2 || (record && record.mastery < 0.45 && record.confidence >= 0.25 && stuck >= 1))) {
    // A prerequisite we have MEASURED as weak beats one we merely have no evidence on — evidence first, then depth.
    const measured = prereqChain(graph, resolved.nodeId).map((c) => ({ c, rec: findConcept(model, graph.nodes[c.id].label) || findConcept(model, c.id) }))
      .filter((x) => x.rec && x.rec.mastery < 0.45 && x.rec.evidence.length >= 2)
      .sort((a, b) => b.c.depth - a.c.depth || a.rec!.mastery - b.rec!.mastery)[0];
    const sb: StepBack | null = measured
      ? { id: measured.c.id, label: graph.nodes[measured.c.id].label, subject: graph.nodes[measured.c.id].subject, depth: measured.c.depth, mastery: measured.rec!.mastery, confidence: measured.rec!.confidence, weak: true, reason: `their recent work on "${graph.nodes[measured.c.id].label}" went wrong ${measured.rec!.evidence.filter((e) => e.kind === "mistake" || e.kind === "misconception").length}× and it sits under what they're asking about` }
      : weakestPrereq(graph, model, resolved.nodeId, { now });
    if (sb) {
      policy.stepBack = sb;
      recommend.push(`Repeated trouble on "${resolved.label}". The real gap may be underneath it — "${sb.label}" (${sb.reason}). Consider STEP_BACK_PREREQUISITE: pause the problem, a 1-2 question check on "${sb.label}", then RETURN to the original problem. Say it plainly ("I think the issue is ${sb.label.toLowerCase()}, not ${resolved.label.toLowerCase()}") — but only if the evidence fits; if unsure, test it.`);
    }
  }

  if (model && state.turns <= 3) {
    const done = new Set(s.retestDone || []);
    const due = Object.values(model.concepts)
      .filter((c) => c.nextReview && Date.parse(c.nextReview) <= now.getTime() && !done.has(c.key) && c.evidence.length > 0)
      .filter((c) => !subject || !c.subject || c.subject.toLowerCase() === subject.toLowerCase())
      .sort((a, b) => Date.parse(a.nextReview!) - Date.parse(b.nextReview!))[0];
    if (due) {
      policy.retest = { key: due.key, label: due.label };
      recommend.push(`"${due.label}" is due for a retrieval check (last shown ${due.lastDemonstrated ? due.lastDemonstrated.slice(0, 10) : "a while ago"}). Fold in ONE quick, natural question on it ("before we go on — quick check: …"), never "time for spaced repetition". Instant answer → move on; hesitation → a short repair.`);
    }
  }

  if (record && record.unaided >= 2 && record.transferAttempts === 0 && record.mastery >= 0.6) {
    policy.transfer = { label: record.label };
    recommend.push(`They can do "${record.label}" unaided — next evidence that matters is TRANSFER: a problem in an unfamiliar context, or "explain why…", not another one of the same.`);
  }
  if (record && record.mastery >= 0.8 && record.confidence >= 0.5 && independence >= 0.7) {
    policy.graduate = true;
    recommend.push(`Mastery of "${record.label}" looks solid and they're independent — say so in a few words ("I think you've got this — try the next one without me") and hand them the next one cold.`);
  }
  if (record) {
    const mis = liveMisconceptions(record, now)[0];
    if (mis) recommend.push(`Known likely misconception on "${record.label}": "${mis.text}" (confidence ${Math.round(mis.confidence * 100)}%). Watch for it; if it shows, make it visible on the board rather than telling them.`);
  }
  if (timeMode === "rush") recommend.push("Time is short: be efficient — fewer probing questions, prioritise what will most likely come up, skip tangents.");
  if (timeMode === "deep") recommend.push("There's time: let them struggle productively and explore why, not just how.");
  if (asksToMoveOn(message)) recommend.push("They asked to move on — do it.");
  return policy;
}

const LEVEL_NAMES = ["open question", "directional question", "narrow question / point at it", "targeted hint", "partial structure (a gap to fill)", "partial solution / parallel worked example", "explanation"];

/** The policy as a prompt block — the app's structured read handed to the model, which still decides. */
export function policyBlock(p: TutorPolicy, state: TutorSessionStateShape): string {
  const s = state as TutorSessionStateShape & { lastPlan?: { action: string; why?: string; expectedNext?: string; diagnosis?: string } ; goalType?: string; minutes?: number; objective?: string; ledger?: string[] };
  const lines = [
    `\n\nTUTOR POLICY FOR THIS TURN (computed by the app from the session so far — it is binding on how MUCH help you give; ` +
    `within it, you decide what to do):`,
    `- Help allowed this turn: up to level ${p.maxLevel} (${LEVEL_NAMES[p.maxLevel]}). Levels: 0 open question · 1 directional · ` +
    `2 narrow/point at it · 3 targeted hint · 4 partial structure (gap) · 5 partial solution/parallel example · 6 explanation. ` +
    `Use the LOWEST level that will let them take the next step themselves.`,
    ...(p.askAttemptFirst ? ["- ANSWER REQUEST WITHOUT AN ATTEMPT: do not give it. Ask, kindly, for what they've tried / their first step."] : []),
    ...(p.concept ? [`- Current concept: ${p.concept.label}${p.concept.record ? ` (mastery ${Math.round(p.concept.record.mastery * 100)}%, ${Math.round(independentSuccess(p.concept.record) * 100)}% solved unaided)` : ""}`] : []),
    ...(s.objective ? [`- Session objective: ${s.objective}`] : []),
    ...(s.goalType || s.minutes ? [`- Their goal: ${s.goalType || "?"}${s.minutes ? `, ~${s.minutes} min available` : ""} → pace: ${p.timeMode}`] : []),
    ...(s.lastPlan ? [`- Your last move: ${s.lastPlan.action}${s.lastPlan.why ? ` — because ${s.lastPlan.why}` : ""}${s.lastPlan.expectedNext ? `; you expected: ${s.lastPlan.expectedNext}` : ""}. Check: did that happen?`] : []),
    ...(s.ledger?.length ? [`- YOUR LEDGER for this problem (what you already verified/judged — stay consistent with it; if you must change a verdict, say plainly that you were wrong, never silently flip):\n${s.ledger.map((l) => `    · ${l}`).join("\n")}`] : []),
    ...p.recommend.map((r) => `- ${r}`),
  ];
  return lines.join("\n") + "\n";
}

/** Does a plan respect the policy? The application's veto — a violating plan gets one corrective round. */
export function validatePlan(plan: TutorPlan | null, p: TutorPolicy): { ok: true } | { ok: false; reason: string } {
  if (!plan) return { ok: true }; // nothing to validate — other guards (answer leaks, questions) still apply
  const lvl = effectiveLevel(plan);
  if (p.askAttemptFirst && !["ASK_QUESTION", "ASK_FOLLOWUP", "ASK_STUDENT_TO_EXPLAIN", "ASK_STUDENT_TO_DRAW", "WAIT", "POINT_TO_OBJECT", "HIGHLIGHT"].includes(plan.action)) {
    return { ok: false, reason: `They asked for the answer without attempting it, so ${plan.action} is not allowed this turn. Ask (kindly, briefly) for their attempt or first step instead.` };
  }
  if (lvl > p.maxLevel) {
    return { ok: false, reason: `${plan.action} at help level ${lvl} is more help than this turn allows (max ${p.maxLevel}: ${LEVEL_NAMES[p.maxLevel]}). They haven't yet shown they need that much — give the smallest step that lets THEM move.` };
  }
  return { ok: true };
}

/* ── applying a turn: the application's update (spec §18/§21/§30/§31) ─────────────────────────────────── */

export interface TurnApply {
  plan: TutorPlan | null;
  /** The action the turn is logged as (plan's, or the classifier's fallback when the model wrote no plan). */
  fallbackAction: TutorAction;
  fallbackWhy: string;
  correctedFrom?: TutorAction;
  correctReason?: string;
  message: string;
  history: { role: string; text: string }[];
  subject?: string;
  exerciseResults?: { correct: boolean; attempt: number }[];
  now: Date;
}

/** Spaced-retrieval interval after a demonstration, by how solid the concept now is (days). */
export function reviewIntervalDays(mastery: number, setback: boolean): number {
  if (setback) return 1;
  if (mastery >= 0.85) return 21;
  if (mastery >= 0.7) return 10;
  if (mastery >= 0.55) return 4;
  return 2;
}

/** Fold one turn into the models. Pure: returns the new session state, student model, graph and decision. */
export function applyTurn(state: TutorSessionStateShape, model: StudentModel | undefined, graph: ConceptGraph | undefined, t: TurnApply): {
  state: TutorSessionStateShape; model: StudentModel; graph: ConceptGraph | undefined; decision: TutorDecisionShape; evidenceKind?: EvidenceKind;
} {
  const { plan, now } = t;
  const s = { ...(state as any) } as TutorSessionStateShape & Record<string, any>;
  let m: StudentModel = model || emptyStudentModel();
  let g = graph;

  // Concept + prerequisites the model named → the graph (a discovered node keeps its stated prerequisite).
  const resolved = resolveConcept(plan?.concept || s.concept, g, t.subject);
  if (resolved) s.concept = resolved.label;
  if (g && plan?.concept && resolved && !resolved.nodeId) {
    const id = `disc.${resolved.key.replace(/ /g, "-").slice(0, 48)}`;
    const pre = plan.prerequisite ? resolveConcept(plan.prerequisite, g, t.subject) : null;
    if (id !== "disc." && !g.nodes[id]) g = mergeDiscovered(g, [{ id, label: resolved.label, subject: t.subject || "General", prereqs: pre?.nodeId ? [pre.nodeId] : [], kind: "discovered", source: "tutor" }], now);
  }

  // Goal / time / objective the model heard the student state.
  if (plan?.goal?.type) s.goalType = plan.goal.type;
  if (plan?.goal?.minutes) s.minutes = plan.goal.minutes;
  if (plan?.objective) s.objective = plan.objective;

  // Hint level on the CURRENT sub-problem: resets when a new question/problem starts, otherwise ratchets up.
  const newSubproblem = plan && ["ASK_QUESTION", "CREATE_PROBLEM", "MOVE_FORWARD", "CHANGE_CONCEPT", "RETEST", "STEP_BACK_PREREQUISITE"].includes(plan.action) && (plan.level ?? 0) <= 1;
  const lvl = plan ? effectiveLevel(plan) : ACTION_LEVEL[t.fallbackAction] ?? 0;
  s.levelNow = newSubproblem ? lvl : Math.max(s.levelNow ?? 0, lvl);
  s.hintRung = Math.max(state.hintRung || 0, lvl);
  if (plan?.action === "RETEST" && resolved) s.retestDone = [...new Set([...(s.retestDone || []), resolved.key])].slice(-12);

  // ── evidence about the concept (app decides the final kind: never "unaided" after real help this sub-problem) ──
  let kind: EvidenceKind | undefined = plan?.evidence?.kind;
  const helpSoFar = state && typeof (state as any).levelNow === "number" ? (state as any).levelNow : 0;
  if (kind === "solved-unaided" && helpSoFar >= 5) kind = "solved-after-partial";
  else if (kind === "solved-unaided" && helpSoFar >= 3) kind = "solved-after-hint";
  // Exercise results are measured by the app, not the model.
  for (const r of t.exerciseResults || []) {
    const k: EvidenceKind = !r.correct ? "mistake" : r.attempt > 1 ? "self-corrected" : helpSoFar >= 3 ? "solved-after-hint" : "solved-unaided";
    if (resolved) m = recordConceptEvidence(m, { label: resolved.label, subject: t.subject, kind: k, evidence: `board exercise, try #${r.attempt}` }, now);
  }
  if (plan?.diagnosis?.type === "misconception" && plan.diagnosis.hypothesis && (plan.diagnosis.confidence ?? 0.5) >= 0.5 && resolved) {
    m = recordConceptEvidence(m, { label: resolved.label, subject: t.subject, kind: "misconception", detail: plan.diagnosis.hypothesis, evidence: t.message.slice(0, 160) }, now);
    if (kind === "misconception") kind = undefined; // already recorded with its hypothesis
  }
  if (kind && resolved) m = recordConceptEvidence(m, { label: resolved.label, subject: t.subject, kind, ...(plan?.evidence?.detail ? { detail: plan.evidence.detail } : {}), evidence: t.message.slice(0, 160) }, now);
  // Spaced retrieval: schedule the next check from how solid it now is.
  if (resolved && (kind || t.exerciseResults?.length)) {
    const rec = findConcept(m, resolved.key);
    if (rec) {
      const setback = kind ? ["mistake", "misconception", "recall-miss", "transfer-fail"].includes(kind) : !!t.exerciseResults?.some((r) => !r.correct);
      const next = new Date(now.getTime() + reviewIntervalDays(rec.mastery, setback) * 86_400_000).toISOString();
      m = { ...m, concepts: { ...m.concepts, [rec.key]: { ...rec, nextReview: next } } };
    }
  }

  // ── session counters ──
  const action: TutorAction = plan?.action || t.fallbackAction;
  const intervention = ["GIVE_HINT", "GIVE_TARGETED_HINT", "EXPLAIN", "SHOW_EXAMPLE", "CREATE_GAP"].includes(action);
  const success = kind ? ["solved-unaided", "self-corrected", "transfer-success", "recall"].includes(kind) : !!t.exerciseResults?.some((r) => r.correct && r.attempt === 1);
  const reaction = reactionTo(t.message, t.history);
  s.turns = (state.turns || 0) + 1;
  s.interventions = (state.interventions || 0) + (intervention ? 1 : 0);
  s.unaidedSuccesses = (state.unaidedSuccesses || 0) + (success ? 1 : 0);
  s.answerSeeks = (state.answerSeeks || 0) + (ANSWER_SEEK.test(t.message) ? 1 : 0);
  s.hintRequests = (state.hintRequests || 0) + (/\b(hint|indice)\b/i.test(t.message) ? 1 : 0);
  s.independence = clamp01((state.independence ?? 0.6) + (success ? 0.07 : 0) - (intervention ? 0.06 : 0) - (ANSWER_SEEK.test(t.message) ? 0.05 : 0));
  s.frustration = reaction.frustrated ? clamp01((state.frustration || 0) * 0.5 + 0.5) : clamp01((state.frustration || 0) * 0.7);
  s.updatedAt = now.toISOString();
  s.recentActions = [...(state.recentActions || []), { at: now.toISOString(), kind: (intervention ? "hint" : action === "CREATE_PROBLEM" ? "problem" : "decision") as "hint" | "problem" | "decision", detail: action }].slice(-12);
  if (plan?.ledger?.length) (s as any).ledger = plan.ledger;
  if (plan) s.lastPlan = { action, ...(plan.why ? { why: plan.why } : {}), ...(plan.expectedNext ? { expectedNext: plan.expectedNext } : {}), ...(plan.diagnosis ? { diagnosis: `${plan.diagnosis.type}${plan.diagnosis.hypothesis ? `: ${plan.diagnosis.hypothesis}` : ""}` } : {}) };
  const rec = resolved ? findConcept(m, resolved.key) : undefined;
  if (rec) { s.mastery = rec.mastery; s.confidence = rec.confidence; const mis = liveMisconceptions(rec, now)[0]; s.liveMisconception = mis?.text; }

  const decision: TutorDecisionShape = {
    at: now.toISOString(), action, ...(t.subject ? { subject: t.subject } : {}),
    why: plan?.why || t.fallbackWhy,
    ...(plan?.target ? { target: plan.target } : resolved ? { target: resolved.label } : {}),
    ...(plan?.diagnosis ? { evidence: `${plan.diagnosis.type}${plan.diagnosis.hypothesis ? `: ${plan.diagnosis.hypothesis}` : ""}${plan.diagnosis.confidence !== undefined ? ` (${Math.round(plan.diagnosis.confidence * 100)}%)` : ""}` } : {}),
    ...(plan?.observe ? { goal: plan.observe } : {}),
    ...(plan?.expectedNext ? { expectedNext: plan.expectedNext } : {}),
    ...(t.correctedFrom ? { correctedFrom: t.correctedFrom, correctReason: t.correctReason } : {}),
  };
  return { state: s, model: m, graph: g, decision, evidenceKind: kind };
}

/** The student's own step, as the model transcribed it, becomes a student-owned board line (spec §10/§11). */
export function studentStepEntry(plan: TutorPlan | null, now: Date, concept?: string): BoardEntry | null {
  if (!plan?.studentStep) return null;
  return {
    id: `stu-${now.getTime().toString(36)}`,
    text: plan.studentStep.text,
    kind: "result",
    owner: "student",
    status: plan.studentStep.status === "partial" ? undefined : plan.studentStep.status,
    ...(concept ? { concept: concept.slice(0, 80) } : {}),
    at: now.toISOString(),
  } as BoardEntry;
}

/** The static protocol text — goes in the cached persona, identical every turn. */
export const PLAN_PROTOCOL =
  `\n\nHOW YOU THINK EACH TURN (hidden — the student never sees this). Before your reply, write ONE line:\n` +
  `<plan>{"observe":"what they just did/said, in a few words","diagnosis":{"type":"none|knowledge-gap|misconception|careless|procedural|prerequisite|dependency|unclear","hypothesis":"what exactly is going on","confidence":0.0-1.0},` +
  `"concept":"the concept in play, short","prerequisite":"a prerequisite concept if relevant","action":"ONE of ${TUTOR_ACTIONS.join("|")}",` +
  `"level":0-6,"target":"board entry or idea you aim at","why":"why this action now","expected_next":"what you expect them to do next",` +
  `"evidence":{"kind":"solved-unaided|solved-after-hint|solved-after-partial|solved-after-explanation|self-corrected|mistake|misconception|recall|recall-miss|transfer-success|transfer-fail","detail":"..."},` +
  `"student_step":{"text":"their step, typeset-ready ($…$ maths)","status":"correct|incorrect|partial"},"ledger":["TRUE: angle TJB = 25° (alternate angles)","WRONG: they said J = 40°"],"goal":{"type":"understand|homework|exam|mastery|review|debug|learn","minutes":N},"objective":"session objective"}</plan>\n` +
  `VERIFY BEFORE YOU SPEAK: before you confirm or reject ANY claim of theirs — and before you state any number — derive it yourself from the givens (use CREATE_CALC for arithmetic; a triangle's angles sum to 180°; an angle of depression equals the angle of elevation at the ground; re-read what the problem actually gives). ` +
  `Record the cumulative verified facts and judged claims in "ledger" (replace it each turn, ≤10 short items, keep what still matters). The ledger is YOUR memory: never contradict it without saying you were wrong, and when they repeat a question, answer it plainly (yes/no and why) from the ledger. Never state a value you computed for THEM to find — judge theirs.\n` +
  `then your reply to the student. Rules: include only the fields that apply (action is required; evidence ONLY when ` +
  `their last move actually showed something about the concept; student_step ONLY when they proposed a step/answer ` +
  `worth writing on the board as THEIR work; goal/objective when they state them). The plan is how you reason — ` +
  `diagnose before you act, pick the smallest help that works, and say when you're unsure (confidence < 0.6 → test the ` +
  `hypothesis with a question instead of teaching to it). The app checks your plan against the TUTOR POLICY and keeps ` +
  `the student model; it will send you back if you over-help.\n`;
