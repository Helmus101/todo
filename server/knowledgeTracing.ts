// KNOWLEDGE TRACING — a small probabilistic model of what each student knows, trained online on their own
// verified answers. Bayesian Knowledge Tracing (a two-state hidden Markov model: the skill is known or not)
// with forgetting, and per-student parameters learned by gradient ascent on the likelihood of what they
// actually answered. No ML library: four parameters per student, one hidden probability per skill.
//
//   · P(known) per skill — updated by Bayes on every code-verified observation, then the learning transition
//   · forgetting — P(known) decays between sessions with a per-skill half-life that grows each time the
//     skill survives a gap (spaced repetition) and shrinks when it doesn't
//   · the student's slip / guess / learn / init rates — learned online: before each observation the model
//     predicts P(correct), and the parameters take one gradient step on the log-likelihood of the outcome,
//     so a careless-but-able student ends up with a high slip rate and a lucky guesser with a high guess rate
//
// What it drives: the skill status the tutor sees (needs review / practising / demonstrated — never "mastered"
// from one answer), whether to vary the task, when a retrieval check is due, and the next activity.
// Pure functions (clock passed in), unit-tested in tests/run.mjs.
import type { ConceptRecord, EvidenceKind, KnowledgeTrace, KnowledgeTraceParams } from "../shared/agentTypes.ts";

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));
const clampP = (p: number) => Math.min(0.999, Math.max(0.001, p));
const DAY = 86_400_000;

/** Priors from the BKT literature (Corbett & Anderson; typical fitted values), as logits. Bounds keep the
 *  model identifiable: guess and slip above 0.3 would mean answers carry almost no information. */
export const DEFAULT_KT_PARAMS: KnowledgeTraceParams = { init: logit(0.3), learn: logit(0.15), slip: logit(0.1), guess: logit(0.2), n: 0 };
const BOUNDS: Record<"init" | "learn" | "slip" | "guess", [number, number]> = {
  init: [0.05, 0.8], learn: [0.03, 0.5], slip: [0.02, 0.3], guess: [0.02, 0.35],
};
const LEARNING_RATE = 0.05;
const START_HALF_LIFE_DAYS = 2;
/** A skill reads "demonstrated" only with P(known) this high, at least this many real observations, and two strong right answers in a row. */
const DEMONSTRATED_P = 0.9;
const DEMONSTRATED_MIN_OBS = 3;
/** Predicted retention below this → a retrieval check is due. */
const RECALL_DUE_AT = 0.7;

export type Observation = { correct: boolean; weight: number; transfer?: boolean };

/** How much an evidence kind says about the skill. Help discounts a right answer: a step solved after the
 *  explanation is weak evidence of knowing it. `objective-done` isn't an observation. */
export function observationFor(kind: EvidenceKind): Observation | null {
  switch (kind) {
    case "solved-unaided": case "self-corrected": case "recall": return { correct: true, weight: 1 };
    case "transfer-success": return { correct: true, weight: 1, transfer: true };
    case "solved-after-hint": return { correct: true, weight: 0.6 };
    case "solved-after-partial": return { correct: true, weight: 0.35 };
    case "solved-after-explanation": return { correct: true, weight: 0.15 };
    case "mistake": case "misconception": case "recall-miss": return { correct: false, weight: 1 };
    case "transfer-fail": return { correct: false, weight: 1, transfer: true };
    default: return null;
  }
}

function probs(params: KnowledgeTraceParams) {
  const b = (k: keyof typeof BOUNDS) => { const [lo, hi] = BOUNDS[k]; return lo + (hi - lo) * sigmoid(params[k]); };
  return { init: b("init"), learn: b("learn"), slip: b("slip"), guess: b("guess") };
}

/** P(known) now, after forgetting since the last observation. Decays toward the student's prior, never below it
 *  — what was never learned can't be forgotten further. */
export function knownNow(kt: KnowledgeTrace | undefined, params: KnowledgeTraceParams, now: Date): number {
  const p0 = probs(params).init;
  if (!kt) return p0;
  const days = Math.max(0, (now.getTime() - Date.parse(kt.at)) / DAY);
  if (!(days > 0)) return kt.p;
  const floor = Math.min(p0, kt.p);
  return floor + (kt.p - floor) * Math.pow(2, -days / kt.halfLife);
}

/** The model's prediction that their next attempt at this skill is right. */
export function predictCorrect(kt: KnowledgeTrace | undefined, params: KnowledgeTraceParams, now: Date): number {
  const { slip, guess } = probs(params);
  const p = knownNow(kt, params, now);
  return p * (1 - slip) + (1 - p) * guess;
}

/** One observation: train the student's parameters on the prediction error, then update the skill's state.
 *  Returns both, new objects — the caller persists them. */
export function traceObservation(kt: KnowledgeTrace | undefined, params: KnowledgeTraceParams, obs: Observation, now: Date): { kt: KnowledgeTrace; params: KnowledgeTraceParams } {
  const pr = probs(params);
  const prior = clampP(knownNow(kt, params, now));
  const y = obs.correct ? 1 : 0;

  // ── learn the parameters: d(log-likelihood)/d(logit) for slip, guess and (on a skill's first sight) init ──
  const pc = prior * (1 - pr.slip) + (1 - prior) * pr.guess;
  const dLdpc = (y - pc) / (pc * (1 - pc));           // ∂ log P(y) / ∂ P(correct)
  const span = (k: keyof typeof BOUNDS) => BOUNDS[k][1] - BOUNDS[k][0];
  const dSig = (x: number) => sigmoid(x) * (1 - sigmoid(x));
  const step = LEARNING_RATE * obs.weight;
  const next: KnowledgeTraceParams = { ...params, n: params.n + 1 };
  next.slip = params.slip + step * dLdpc * (-prior) * span("slip") * dSig(params.slip);
  next.guess = params.guess + step * dLdpc * (1 - prior) * span("guess") * dSig(params.guess);
  if (!kt) next.init = params.init + step * dLdpc * ((1 - pr.slip) - pr.guess) * span("init") * dSig(params.init);
  // learn: P(known) now = post + (1 − post)·learn (before forgetting), so ∂prior/∂learn ≈ 1 − post
  if (kt) next.learn = params.learn + step * dLdpc * ((1 - pr.slip) - pr.guess) * (1 - kt.post) * span("learn") * dSig(params.learn);
  for (const k of ["init", "learn", "slip", "guess"] as const) next[k] = Math.max(-6, Math.min(6, next[k]));

  // ── update the skill: Bayes on the observation, softened by its weight, then the learning transition ──
  const post = obs.correct
    ? (prior * (1 - pr.slip)) / pc
    : (prior * pr.slip) / (1 - pc);
  const softened = prior + obs.weight * (post - prior);
  const p = clampP(softened + (1 - softened) * pr.learn * obs.weight);

  // ── spacing: surviving a gap of at least half the half-life doubles it; failing halves it ──
  const prev = kt?.halfLife ?? START_HALF_LIFE_DAYS;
  const gapDays = kt ? (now.getTime() - Date.parse(kt.at)) / DAY : 0;
  const halfLife = !obs.correct ? Math.max(0.5, prev / 2)
    : kt && gapDays >= prev / 2 && obs.weight >= 0.6 ? Math.min(120, prev * 2)
    : prev;

  return {
    params: next,
    kt: {
      p: Math.round(p * 1000) / 1000,
      post: Math.round(clampP(softened) * 1000) / 1000,
      at: now.toISOString(),
      halfLife: Math.round(halfLife * 100) / 100,
      n: (kt?.n ?? 0) + (obs.weight >= 0.6 ? 1 : 0),
      streak: obs.correct && obs.weight >= 1 ? (kt?.streak ?? 0) + 1 : obs.correct ? (kt?.streak ?? 0) : 0,
      transfer: (kt?.transfer ?? false) || (!!obs.transfer && obs.correct),
    },
  };
}

export type SkillStatus = "needs review" | "practising" | "demonstrated";
export interface SkillRead {
  status: SkillStatus;
  known: number;
  predicted: number;
  recallDue: boolean;
  /** One short instruction for the tutor: what kind of activity this skill needs next. */
  next: string;
}

/** The tutor-facing read of one skill. */
export function readSkill(rec: Pick<ConceptRecord, "kt">, params: KnowledgeTraceParams, now: Date): SkillRead | null {
  const kt = rec.kt;
  if (!kt) return null;
  const known = knownNow(kt, params, now);
  const predicted = predictCorrect(kt, params, now);
  const retention = kt.p > 0 ? known / kt.p : 1;
  const recallDue = kt.p >= 0.6 && retention < RECALL_DUE_AT;
  const status: SkillStatus = known >= DEMONSTRATED_P && kt.n >= DEMONSTRATED_MIN_OBS && kt.streak >= 2 ? "demonstrated" : known < 0.4 ? "needs review" : "practising";
  const next = recallDue ? "a quick retrieval question before anything new (it's fading)"
    : status === "demonstrated" && !kt.transfer ? "a transfer task — a graph, a concept question, an application or an error to spot — not another drill of the same kind"
    : status === "demonstrated" ? "move on to the next skill; come back to this one later for spacing"
    : known < 0.25 ? "a worked example with the reasoning on the board, then a faded one for them"
    : kt.streak >= 2 || known >= 0.7 ? "a slightly harder problem of the same kind, with less help"
    : "a similar problem with different numbers, help kept light";
  return { status, known, predicted, recallDue, next };
}
