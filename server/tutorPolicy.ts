// A small neural network the tutor trains ONLINE, per student, with reinforcement learning (REINFORCE with a
// baseline). No ML library: a shared tanh hidden layer feeds two softmax "heads", so one forward pass decides
//   · the TEACHING MOVE for this turn (probe, smaller step, parallel example, picture, analogy, reflect-back, hint)
//   · the PACE for this turn (slow down / steady / stretch)
// The input is a context vector built from the live conversation (how stuck they are, how they just reacted, the
// subject, the time of day, how long the session has run, what move was used last…). After the student's NEXT
// message the reaction is turned into a reward (tutorAdapt.reactionTo) and the weights take one gradient step on
// exactly the action that was taken: actions that were followed by good reactions become more likely in similar
// contexts, bad ones less. Weights persist per student (store.ts bandit table, JSON), so Otto gets more personal
// with every session. It starts near-uniform (small random weights, exploration kept alive by an entropy bonus and
// a probability floor) and never overrides the safety guards — it only chooses HOW to teach, never WHAT is said.
import type { Reaction } from "./tutorAdapt.ts";

export const MOVES = ["probe", "smaller-step", "worked-parallel", "visual", "analogy", "reflect-back", "direct-hint"] as const;
export const PACES = ["slow", "steady", "stretch"] as const;
export type Move = (typeof MOVES)[number];
export type Pace = (typeof PACES)[number];

const SUBJECT_BUCKETS = 6;
/** v2 adds three context features the policy can genuinely personalize on and the caller ALREADY has (see
 *  planTurn's `context`): subject mastery, how far through this session's objectives the student is, and how
 *  full the board already is — a page that has been built up changes what a student needs next (more
 *  scaffolding, or room to stretch). Bumping `Policy.v` to 2 is what makes old weights get DISCARDED cleanly
 *  at parse time instead of being misread against a longer feature vector (the arrays would still be
 *  numeric — silently wrong — which is exactly the failure a version field exists to prevent). */
export const FEATURE_DIM = 5 /* last reaction one-hot */ + 1 /* stuck streak */ + 1 /* turn depth */ + SUBJECT_BUCKETS + 2 /* time of day */ + 1 /* message length */ + 1 /* has maths */ + 1 /* recent wrong exercises */ + 1 /* repeated-student flag */ + MOVES.length /* previous move */ + 1 /* bias */ + 3 /* mastery, objective progress, board richness */;
const HIDDEN = 14;

export interface Policy {
  v: 2;
  W1: number[]; b1: number[];            // HIDDEN × FEATURE_DIM, HIDDEN
  Wm: number[]; bm: number[];            // MOVES × HIDDEN, MOVES
  Wp: number[]; bp: number[];            // PACES × HIDDEN, PACES
  baseline: number;                       // running mean reward (variance reduction)
  updates: number;
}

export interface Context {
  reaction: Reaction["label"];
  stuckStreak: number;
  turn: number;                           // assistant turns so far
  subject?: string;
  hour: number;                           // 0-23 local
  messageWords: number;
  hasMaths: boolean;
  recentWrong: number;                    // wrong exercises among the last few student messages
  repeatedStudent: boolean;
  prevMove?: Move;
  /** 0-1 subject mastery (task.mastery / the subject's own correct-rate signal). Undefined when there is no
   *  evidence yet — encoded as a neutral 0.5 rather than 0, which would read as "this student knows nothing". */
  mastery?: number;
  /** 0-1 fraction of this session's objectives already marked done. Undefined when no objectives were set. */
  objectiveProgress?: number;
  /** 0-1 how full the board already is — a page that has been built up changes what they need next. */
  boardRich?: number;
}

// deterministic tiny PRNG so weights init / sampling are reproducible in tests
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());

export function initPolicy(seed = 7): Policy {
  const r = rng(seed);
  const mat = (n: number, scale: number) => Array.from({ length: n }, () => gauss(r) * scale);
  return {
    v: 2,
    W1: mat(HIDDEN * FEATURE_DIM, 0.25), b1: new Array(HIDDEN).fill(0),
    Wm: mat(MOVES.length * HIDDEN, 0.05), bm: new Array(MOVES.length).fill(0),   // near-uniform to start
    Wp: mat(PACES.length * HIDDEN, 0.05), bp: [0, 0.3, 0],                       // "steady" slightly favoured at first
    baseline: 0.5, updates: 0,
  };
}

const REACTIONS: Reaction["label"][] = ["frustrated", "repeated", "positive", "attempt", "neutral"];
function hashSubject(s?: string): number {
  if (!s) return 0;
  let h = 0; for (const c of s.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 1 + (h % (SUBJECT_BUCKETS - 1));
}
export function featuresFor(c: Context): number[] {
  const x = new Array(FEATURE_DIM).fill(0);
  let i = 0;
  x[i + REACTIONS.indexOf(c.reaction)] = 1; i += REACTIONS.length;
  x[i++] = Math.min(c.stuckStreak, 4) / 4;
  x[i++] = Math.min(1, Math.log1p(c.turn) / Math.log(40));
  x[i + hashSubject(c.subject)] = 1; i += SUBJECT_BUCKETS;
  const night = c.hour >= 21 || c.hour < 6, morning = c.hour >= 6 && c.hour < 12;
  x[i++] = night ? 1 : 0; x[i++] = morning ? 1 : 0;
  x[i++] = Math.min(1, c.messageWords / 40);
  x[i++] = c.hasMaths ? 1 : 0;
  x[i++] = Math.min(c.recentWrong, 3) / 3;
  x[i++] = c.repeatedStudent ? 1 : 0;
  if (c.prevMove) x[i + MOVES.indexOf(c.prevMove)] = 1; i += MOVES.length;
  x[i++] = c.mastery === undefined ? 0.5 : Math.max(0, Math.min(1, c.mastery));
  x[i++] = Math.max(0, Math.min(1, c.objectiveProgress ?? 0));
  x[i++] = Math.max(0, Math.min(1, c.boardRich ?? 0));
  x[i++] = 1;
  return x;
}

function softmax(z: number[]): number[] {
  const m = Math.max(...z); const e = z.map((v) => Math.exp(v - m)); const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}
export interface Forward { x: number[]; h: number[]; pm: number[]; pp: number[] }
export function forward(p: Policy, x: number[]): Forward {
  const h = new Array(HIDDEN).fill(0);
  for (let j = 0; j < HIDDEN; j++) { let a = p.b1[j]; for (let i = 0; i < FEATURE_DIM; i++) a += p.W1[j * FEATURE_DIM + i] * x[i]; h[j] = Math.tanh(a); }
  const head = (W: number[], b: number[], n: number) => softmax(Array.from({ length: n }, (_, k) => { let a = b[k]; for (let j = 0; j < HIDDEN; j++) a += W[k * HIDDEN + j] * h[j]; return a; }));
  return { x, h, pm: head(p.Wm, p.bm, MOVES.length), pp: head(p.Wp, p.bp, PACES.length) };
}

const FLOOR = 0.04; // exploration never dies: every action keeps at least this probability
function sampleFrom(probs: number[], r: () => number, banned?: number): number {
  const q = probs.map((v, i) => (i === banned ? 0 : Math.max(v, FLOOR)));
  const s = q.reduce((a, b) => a + b, 0); let u = r() * s;
  for (let i = 0; i < q.length; i++) { u -= q[i]; if (u <= 0) return i; }
  return q.length - 1;
}

export interface Experience { x: number[]; move: number; pace: number; pm: number[]; pp: number[] }
/** Choose this turn's move + pace from the policy. `avoidMove` (the move that just failed) is never served twice. */
export function act(p: Policy, c: Context, r: () => number = Math.random, avoidMove?: Move): { move: Move; pace: Pace; exp: Experience } {
  const f = forward(p, featuresFor(c));
  const mi = sampleFrom(f.pm, r, avoidMove ? MOVES.indexOf(avoidMove) : undefined);
  const pi = sampleFrom(f.pp, r);
  return { move: MOVES[mi], pace: PACES[pi], exp: { x: f.x, move: mi, pace: pi, pm: f.pm, pp: f.pp } };
}

const LR = 0.08, ENTROPY = 0.01, L2 = 1e-4, CLIP = 1.0;
/** One REINFORCE step: reward ∈ [0,1] for the action that was taken; advantage = reward − running baseline. */
export function learn(p: Policy, exp: Experience, reward: number): Policy {
  const f = forward(p, exp.x);
  const adv = reward - p.baseline;
  const n: Policy = { ...p, W1: p.W1.slice(), b1: p.b1.slice(), Wm: p.Wm.slice(), bm: p.bm.slice(), Wp: p.Wp.slice(), bp: p.bp.slice() };
  const dh = new Array(HIDDEN).fill(0);
  const headStep = (W: number[], b: number[], probs: number[], taken: number) => {
    const ent = -probs.reduce((a, v) => a + v * Math.log(Math.max(v, 1e-9)), 0);
    for (let k = 0; k < probs.length; k++) {
      // d(log π_taken)/d logit_k = 1[k=taken] − p_k ; plus a small entropy bonus gradient to keep exploring
      let g = adv * ((k === taken ? 1 : 0) - probs[k]) + ENTROPY * probs[k] * (-Math.log(Math.max(probs[k], 1e-9)) - ent);
      g = Math.max(-CLIP, Math.min(CLIP, g));
      for (let j = 0; j < HIDDEN; j++) { dh[j] += g * W[k * HIDDEN + j]; W[k * HIDDEN + j] += LR * (g * f.h[j] - L2 * W[k * HIDDEN + j]); }
      b[k] += LR * g;
    }
  };
  headStep(n.Wm, n.bm, f.pm, exp.move);
  headStep(n.Wp, n.bp, f.pp, exp.pace);
  for (let j = 0; j < HIDDEN; j++) {
    const g = Math.max(-CLIP, Math.min(CLIP, dh[j] * (1 - f.h[j] * f.h[j])));
    for (let i = 0; i < FEATURE_DIM; i++) n.W1[j * FEATURE_DIM + i] += LR * (g * exp.x[i] - L2 * n.W1[j * FEATURE_DIM + i]);
    n.b1[j] += LR * g;
  }
  n.baseline = p.baseline + 0.05 * (reward - p.baseline);
  n.updates = p.updates + 1;
  return n;
}

const PACE_TEXT: Record<Pace, string> = {
  slow: "SLOW DOWN: smaller steps, one idea at a time, check understanding before moving on, more scaffolding.",
  steady: "STEADY pace: normal step size, hints only when needed.",
  stretch: "STRETCH: this student can handle more — bigger steps, fewer hints, push for the reason or a generalisation.",
};
export const paceLine = (p: Pace): string => `\nPACE THIS TURN (learned for this student): ${PACE_TEXT[p]}\n`;

/** For transparency in Settings: what the policy currently favours in a calm context vs a stuck one. */
export function summarize(p: Policy): { updates: number; flow: { move: Move; pace: Pace }; stuck: { move: Move; pace: Pace } } {
  const best = (c: Context) => { const f = forward(p, featuresFor(c)); return { move: MOVES[f.pm.indexOf(Math.max(...f.pm))], pace: PACES[f.pp.indexOf(Math.max(...f.pp))] }; };
  const base: Context = { reaction: "attempt", stuckStreak: 0, turn: 6, hour: 17, messageWords: 12, hasMaths: true, recentWrong: 0, repeatedStudent: false };
  return { updates: p.updates, flow: best(base), stuck: best({ ...base, reaction: "frustrated", stuckStreak: 2, recentWrong: 1 }) };
}

export function parsePolicy(raw: unknown): Policy | null {
  const p = raw as Policy | undefined;
  const ok = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every((v) => typeof v === "number" && Number.isFinite(v));
  if (!p || p.v !== 2 || !ok(p.W1, HIDDEN * FEATURE_DIM) || !ok(p.b1, HIDDEN) || !ok(p.Wm, MOVES.length * HIDDEN) || !ok(p.bm, MOVES.length) || !ok(p.Wp, PACES.length * HIDDEN) || !ok(p.bp, PACES.length) || !Number.isFinite(p.baseline) || !Number.isFinite(p.updates)) return null;
  return p;
}
