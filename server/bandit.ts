/**
 * Contextual-bandit personalization — v1 target: Pomodoro work/break length (see the approved plan for the
 * full design rationale). Deliberately Thompson Sampling over a small number of discrete (context, arm)
 * cells: a Beta(α, β) posterior per cell, no ML library, converges usefully from tens-to-low-hundreds of
 * trials — the right scale for what a single real student generates. Pure logic only (no I/O) — persistence
 * lives in server/store.ts, exactly like tasks.ts (pure) vs. store.ts (I/O) elsewhere in this codebase.
 */
import type { Profile } from "../shared/types.ts";

/** One (workMinutes, breakMinutes) option, or no-Pomodoro. Fixed, small menu — matched to how little data
 *  one student generates; a continuous action space would never converge on this little traffic. */
export interface PomodoroArm { id: string; enabled: boolean; workMinutes: number; breakMinutes: number }
export const POMODORO_ARMS: PomodoroArm[] = [
  { id: "none", enabled: false, workMinutes: 0, breakMinutes: 0 },
  { id: "25/5", enabled: true, workMinutes: 25, breakMinutes: 5 },
  { id: "45/10", enabled: true, workMinutes: 45, breakMinutes: 10 },
  { id: "50/15", enabled: true, workMinutes: 50, breakMinutes: 15 },
  { id: "90/20", enabled: true, workMinutes: 90, breakMinutes: 20 },
];

/** Second bandit target: flashcard deck verbosity/length — same Thompson Sampling machinery, a different
 *  arm menu and decision key ("flashcards" vs "pomodoro"). "concise" biases generateDailyStudyCards toward
 *  short backs and fewer cards; "thorough" toward longer backs/worked solutions and more cards; "standard"
 *  is today's default (CARD_STYLE_RULE, unmodified). Reward comes from Leitner box movement on THAT deck's
 *  cards (see computeCardReward) — scored the next time a deck is generated for this student, since review
 *  activity only accumulates after the deck exists. */
export interface FlashcardArm { id: "concise" | "standard" | "thorough" }
export const FLASHCARD_ARMS: FlashcardArm[] = [
  { id: "concise" },
  { id: "standard" },
  { id: "thorough" },
];

/** Per-arm Beta posterior. `a`/`b` start at 1/1 (uniform prior — no assumption about what works before any
 *  data exists, which is the correct, safe cold-start default rather than guessing a favorite). */
export interface BetaPosterior { a: number; b: number }
/** One context "cell" → one posterior per arm. Keyed by contextKey() below. */
export type BanditState = Record<string, Record<string, BetaPosterior>>;

/** Discrete, interpretable context features — NOT a learned embedding, which would be overkill for the
 *  data volume a single user produces. Time-of-day and day-of-week are the two coarse behavioral splits
 *  worth distinguishing (a 90-minute block that works at 4pm on a Saturday may not on a Tuesday morning);
 *  track is the one durable per-student trait already on the profile. */
export function contextKey(now: Date, profile?: Profile): string {
  const hour = now.getHours();
  const timeBucket = hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night";
  const isWeekend = [0, 6].includes(now.getDay());
  const track = profile?.track || "other";
  return `${timeBucket}|${isWeekend ? "weekend" : "weekday"}|${track}`;
}

function getCell(state: BanditState, key: string): Record<string, BetaPosterior> {
  return state[key] || {};
}
function getPosterior(cell: Record<string, BetaPosterior>, armId: string): BetaPosterior {
  return cell[armId] || { a: 1, b: 1 };
}

// Box-Muller via a standard uniform RNG, then a simple Beta-from-two-Gammas sampler (Marsaglia-Tsang) — no
// dependency needed for the small integer-ish a/b this ever sees in practice. `rng` is injectable so the
// sampling is deterministic and testable (tests/run.mjs seeds it), and swappable for Math.random in prod.
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    // Boost by 1 and correct — Marsaglia-Tsang requires shape >= 1.
    const u = rng();
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      // Standard-normal via Box-Muller.
      const u1 = Math.max(rng(), 1e-12), u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function sampleBeta(a: number, b: number, rng: () => number): number {
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  return x / (x + y);
}

/** Thompson Sampling: draw one sample per arm's posterior, serve the highest. `rng` defaults to Math.random
 *  in production; tests pass a seeded generator for determinism. Returns the arm plus whether this cell had
 *  ANY prior data — a cold-start pick (uniform prior everywhere) should be shown to the student as a
 *  default, not a confident "Otto recommends this", since it genuinely isn't one yet. */
export function chooseArm<T extends { id: string }>(arms: T[], state: BanditState, key: string, rng: () => number = Math.random): { arm: T; coldStart: boolean } {
  const cell = getCell(state, key);
  const coldStart = Object.keys(cell).length === 0;
  let best = arms[0], bestSample = -1;
  for (const arm of arms) {
    const { a, b } = getPosterior(cell, arm.id);
    const sample = sampleBeta(a, b, rng);
    if (sample > bestSample) { bestSample = sample; best = arm; }
  }
  return { arm: best, coldStart };
}

/** Reward inputs — every one of these is ALREADY computed/available elsewhere in the app (see the plan's
 *  "What's already there" section); this function only combines them. Weighted equally to start (see the
 *  plan: the ARM choice is what the bandit adapts, this formula is a simpler, revisitable constant, not
 *  something to hand-tune before any real outcome data exists). Clipped to [0, 1]. */
export function computeReward(input: {
  /** Did the session run its planned length without an early "End session"? */
  completedPlanned: boolean;
  /** Fraction of the session spent idle (chromeIdle-derived) — 0 = fully engaged, 1 = fully idle. */
  idleRatio: number;
  /** Net Leitner box movement this session (reviews that advanced minus reviews that reset) — undefined
   *  when no flashcards were reviewed this session, in which case that term is simply omitted, not zeroed
   *  (a session with no review activity shouldn't be penalized for a signal that doesn't apply to it). */
  netBoxDelta?: number;
}): number {
  const terms: number[] = [input.completedPlanned ? 1 : 0, 1 - Math.max(0, Math.min(1, input.idleRatio))];
  if (input.netBoxDelta !== undefined) {
    terms.push(normalizeBoxDelta(input.netBoxDelta));
  }
  const reward = terms.reduce((s, t) => s + t, 0) / terms.length;
  return Math.max(0, Math.min(1, reward));
}

/** ±3 net Leitner box moves in one batch of reviews is already a strong signal either way — shared between
 *  the Pomodoro reward (a session that included some review activity) and the flashcard-style reward below
 *  (which is ENTIRELY this signal, since a deck has no session length/idle-ratio of its own). */
function normalizeBoxDelta(delta: number): number {
  return Math.max(0, Math.min(1, 0.5 + delta / 6));
}

/** Reward for the flashcard-style arm: purely how well that deck's cards actually got retained, i.e. net
 *  Leitner box movement across its cards since creation (reviews that advanced a card's box minus reviews
 *  that reset one to box 1). Unlike Pomodoro's reward, there's no session-length/idle signal to blend in —
 *  a deck IS its review outcomes. `undefined` (no reviews yet) means "don't score this deck" — the caller
 *  should skip the posterior update entirely rather than treating no data as a bad outcome. */
export function computeCardReward(netBoxDelta: number): number {
  return normalizeBoxDelta(netBoxDelta);
}

/** Third bandit target: task step granularity. "standard" is today's normal step breakdown; "granular"
 *  appends an instruction asking the generator to split work into smaller, more numerous steps — the
 *  concrete "if it took a while, try smaller steps" behavior. Reward is the procrastination-latency signal
 *  (WebTask.shownAt -> firstActionAt, see shared/types.ts) already collected for exactly this purpose. */
export interface GranularityArm { id: "standard" | "granular" }
export const GRANULARITY_ARMS: GranularityArm[] = [{ id: "standard" }, { id: "granular" }];

/** Fourth bandit target: the desk's background ambience — the "pre-configured environment" the user asked
 *  for ("if trends emerge in study mode, pre-build that environment... automatically queuing up a playlist
 *  if the user always listens to it"). Rather than a separate frequency-counting system, this reuses the
 *  EXACT same machinery as the other three: an ambience choice IS a repeated decision with an observable
 *  outcome (did the session run its full length, how idle was the student), so it converges the same way
 *  Pomodoro length does. Custom uploads and Spotify links aren't arms here — those are the student's own
 *  explicit pick each time, not a small enumerable menu; this only learns among the built-in noise presets. */
export interface AudioArm { id: "silence" | "brown" | "pink" | "white" }
export const AUDIO_ARMS: AudioArm[] = [{ id: "silence" }, { id: "brown" }, { id: "pink" }, { id: "white" }];

/** Fifth bandit target: overall UI density — the "adapt background/borders/rounding/text size" ask from the
 *  personalization plan. "cozy" is today's default (unchanged tokens); "compact" and "spacious" are two
 *  hand-written, bounded token overrides (client/styles.css's [data-density] rules) that re-scale spacing,
 *  type, and corner radius together — never generated/mutated CSS, just a different pre-written stylesheet
 *  variant picked the same way Pomodoro length is. Reward reuses computeReward (session completion + idle
 *  ratio) exactly like audio does — a layout a student is comfortable in should show up as more focused
 *  sessions, not a bespoke metric. A student's own manual choice in Settings always overrides this and is
 *  never silently changed back (see StudySetup's identical posture for Pomodoro/audio). */
export interface DensityArm { id: "cozy" | "compact" | "spacious" }
export const DENSITY_ARMS: DensityArm[] = [{ id: "cozy" }, { id: "compact" }, { id: "spacious" }];

/** Sixth bandit target: dashboard ORDERING strategy, layered on top of (never replacing) the existing
 *  Eisenhower sort (sortWithinQuadrant, shared/types.ts). "urgency-first" is today's plain behavior;
 *  "quick-wins-first" nudges low-effort tasks up (momentum); "subject-balanced" spreads picks across
 *  subjects instead of one subject's tasks dominating the top of the list. Applied ambiently — the list
 *  just quietly orders better, no visible control for the student to fiddle with. */
export interface OrderingArm { id: "urgency-first" | "quick-wins-first" | "subject-balanced" }
export const ORDERING_ARMS: OrderingArm[] = [{ id: "urgency-first" }, { id: "quick-wins-first" }, { id: "subject-balanced" }];

/** Seventh bandit target: tutor chat style bias, folded into chatAboutTask's system prompt (server/claude.ts).
 *  "concise" is today's default tone; "socratic" leans harder into question-first (the methodology block
 *  already asks for this somewhat — this arm decides HOW MUCH); "worked-example" leans toward a parallel
 *  worked example before asking the student to try. Reward: does the student send a follow-up (real
 *  engagement) rather than the guardrail tripping or the thread just going quiet. */
export interface ChatStyleArm { id: "concise" | "socratic" | "worked-example" }
export const CHAT_STYLE_ARMS: ChatStyleArm[] = [{ id: "concise" }, { id: "socratic" }, { id: "worked-example" }];

/** Shorter time-to-first-action -> higher reward. 6 hours+ is treated as "so slow it may as well be zero"
 *  rather than picking a razor-thin threshold — a student's first free moment after seeing a task can
 *  legitimately be hours later for reasons that have nothing to do with step size, so the curve is
 *  deliberately gentle/wide, not a tight pass/fail cutoff. A simple, revisitable constant, same posture as
 *  computeReward's own weighting. */
export function computeLatencyReward(latencySeconds: number): number {
  const SLOW_CEILING_SECONDS = 6 * 3600;
  return Math.max(0, Math.min(1, 1 - latencySeconds / SLOW_CEILING_SECONDS));
}

// Forgetting factor applied to EVERY arm's posterior (including the one just updated, before its own
// increment) on each update — pulls old evidence gently back toward the uniform prior (a=1,b=1) so a habit
// that was reinforced last term can't permanently dominate once it's stopped being true. This is what makes
// Thompson Sampling here "discounted"/non-stationary rather than accumulating forever — the standard fix for
// a bandit that needs to keep adapting across a long deployment (a school year), not converge once and stop
// listening. Small (1%) so it's invisible on the timescale of days/weeks (tens of updates) and only actually
// matters over hundreds of updates (a real shift in behavior over months) — verified by the "an arm that WAS
// winning loses its edge after enough contradicting evidence, faster than un-discounted" test in tests/run.mjs.
const FORGETTING_FACTOR = 0.99;
function discountToward1(n: number): number {
  return 1 + (n - 1) * FORGETTING_FACTOR;
}

/** Update one cell's posterior for the arm that was actually served, given the observed reward — mapped to
 *  a Bernoulli success via a simple 0.5 threshold (the standard, most robust reduction for Beta-Bernoulli
 *  Thompson Sampling at this data volume; a continuous reward model would need far more data per cell than
 *  exists here to fit safely). Every arm in the cell is discounted toward the uniform prior first (see
 *  FORGETTING_FACTOR) — non-stationary, so old evidence fades rather than permanently dominating. Returns a
 *  NEW state object (pure) — the caller persists it. */
export function updatePosterior(state: BanditState, key: string, armId: string, reward: number): BanditState {
  const cell = getCell(state, key);
  const discountedCell: Record<string, BetaPosterior> = {};
  for (const [id, post] of Object.entries(cell)) {
    discountedCell[id] = { a: discountToward1(post.a), b: discountToward1(post.b) };
  }
  const prev = discountedCell[armId] || getPosterior(cell, armId);
  const success = reward >= 0.5;
  const next: BetaPosterior = success ? { a: prev.a + 1, b: prev.b } : { a: prev.a, b: prev.b + 1 };
  return { ...state, [key]: { ...discountedCell, [armId]: next } };
}
