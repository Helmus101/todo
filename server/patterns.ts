/**
 * Pattern recognition — predicts the student's next likely move from data the metrics pipeline and
 * activity-hour tracking (shared/types.ts) already collect. Deliberately NOT a bandit: the 5 bandits
 * (server/bandit.ts) each answer "given I'm about to make THIS decision, which option works best?" — this
 * answers a different question, "what is this student about to do, unprompted?" Same philosophy as the
 * bandits though: small, interpretable, statistical, no ML library, no new AI calls — a plain, inspectable
 * score from countable history, never a black-box output. Pure functions only (no I/O); the async reads
 * that feed them (loading the metrics log) live in server/index.ts, same pure-vs-I/O split as tasks.ts vs
 * store.ts elsewhere in this codebase.
 */
import type { Profile, WebTask } from "../shared/types.ts";
import { deadlineEpoch } from "../shared/types.ts";

/** This student's most likely (weekday, hour) to engage next, from the 7x24 grid — or null when there isn't
 *  enough history to trust yet (same cold-start posture as learnedProductiveHour). `minTotal` mirrors that
 *  function's own threshold: engagement events are frequent enough that a real pattern shows up well before
 *  a month of use. Weekday is 0=Sunday..6=Saturday, matching Date.prototype.getDay(). */
export function predictNextEngagement(profile: Profile | undefined, minTotal = 20): { weekday: number; hour: number; confidence: number } | null {
  const grid = profile?.activityWeekdayHours;
  if (!grid || grid.length !== 168) return null;
  const total = grid.reduce((s, n) => s + (n || 0), 0);
  if (total < minTotal) return null;
  let best = 0;
  for (let i = 1; i < 168; i++) if ((grid[i] || 0) > (grid[best] || 0)) best = i;
  // Confidence: how concentrated the history is on the winning cell, scaled by how much history exists
  // overall — a cell that's 40% of only 20 events is a weaker signal than 40% of 200. Transparent and
  // derived straight from the same counts a reader could recompute by hand, never a hidden model output.
  const confidence = confidenceFromEvidence(grid[best] || 0, total);
  return { weekday: Math.floor(best / 24), hour: best % 24, confidence };
}

/** Shared confidence formula for every prediction in this file: `share` of the winning bucket, scaled by how
 *  much total evidence exists (saturating — evidence beyond ~100 events doesn't add much more confidence,
 *  it's already a real pattern by then). Clamped to [0, 1]. Deliberately simple arithmetic, not a fitted
 *  model — consistent with this whole layer's "plain, inspectable score" posture. */
function confidenceFromEvidence(winnerCount: number, total: number): number {
  if (total <= 0) return 0;
  const share = winnerCount / total;
  const evidenceFactor = Math.min(1, total / 100);
  return Math.max(0, Math.min(1, share * evidenceFactor));
}

/** Given a map of subject -> recent correct-rate (already aggregated by the caller from flashcard_struggle/
 *  quiz_attempt_score_ratio metrics — this function stays pure, it doesn't read the metrics store itself),
 *  rank which subjects most need reinforcement. Only flags a subject once it has enough attempts to be a
 *  real pattern, not one unlucky card (minAttempts) — and only when the rate is genuinely weak, not just
 *  imperfect (threshold), so this stays a rare, meaningful signal rather than nagging about every subject. */
export interface SubjectSignal {
  subject: string; correctRate: number; attempts: number;
  /** Recent-vs-prior direction, when there's enough quiz-attempt HISTORY to tell (attempts carry real
   *  timestamps; flashcard review counts are cumulative and can't tell recent from old on their own) —
   *  undefined when there isn't enough history for a trend to mean anything. */
  trend?: "up" | "down" | "flat";
}
/** Trend shifts the effective threshold: a subject trending DOWN gets flagged a bit more readily (catching
 *  a slide before it's a crisis), one trending UP needs to be more clearly still weak before nagging about
 *  something the student is already fixing on their own — the whole point of tracking trend at all, not
 *  just a static snapshot. */
export function predictWeakSubjects(signals: SubjectSignal[], opts?: { minAttempts?: number; threshold?: number }): string[] {
  const minAttempts = opts?.minAttempts ?? 3;
  const threshold = opts?.threshold ?? 0.6;
  return signals
    .filter((s) => {
      if (s.attempts < minAttempts) return false;
      const effectiveThreshold = s.trend === "down" ? threshold + 0.1 : s.trend === "up" ? threshold - 0.1 : threshold;
      return s.correctRate < effectiveThreshold;
    })
    .sort((a, b) => a.correctRate - b.correctRate)
    .map((s) => s.subject);
}

/** Recent-vs-prior direction from a real, timestamped attempt history (quiz attempts only — flashcard
 *  review counts are cumulative and have no per-event history to compare against). Needs 2+ attempts to say
 *  anything; a >=10-point swing in correct-rate is treated as a real shift, smaller noise stays "flat". */
function quizTrend(attempts: { score: number; total: number }[]): "up" | "down" | "flat" | undefined {
  if (attempts.length < 2) return undefined;
  const last = attempts[attempts.length - 1];
  const lastRate = last.total ? last.score / last.total : 0;
  const priorRates = attempts.slice(0, -1).filter((a) => a.total).map((a) => a.score / a.total);
  if (!priorRates.length) return undefined;
  const priorAvg = priorRates.reduce((s, r) => s + r, 0) / priorRates.length;
  if (lastRate - priorAvg > 0.1) return "up";
  if (priorAvg - lastRate > 0.1) return "down";
  return "flat";
}

/** Aggregate per-subject correct-rate signals straight from a student's OWN task data (flashcard reviews +
 *  quiz attempts already on each task) — no metrics-log query needed, this reads the same authoritative
 *  data the student's own decks/quizzes already show. Pure: takes the task list as a plain argument. */
export function aggregateSubjectSignals(tasks: WebTask[]): SubjectSignal[] {
  const bySubject = new Map<string, { correct: number; seen: number }>();
  const trendBySubject = new Map<string, "up" | "down" | "flat">();
  const bump = (subject: string | undefined, correct: number, seen: number) => {
    if (!subject || !seen) return;
    const prev = bySubject.get(subject) || { correct: 0, seen: 0 };
    bySubject.set(subject, { correct: prev.correct + correct, seen: prev.seen + seen });
  };
  for (const t of tasks) {
    for (const deck of t.flashcards || []) {
      for (const c of deck.cards) if (c.review?.seen) bump(t.sourceSubject, c.review.correct || 0, c.review.seen);
    }
    for (const q of t.quizzes || []) {
      const last = q.attempts?.[q.attempts.length - 1];
      if (last) bump(t.sourceSubject, last.score, last.total);
      // Most recent quiz's trend wins if a subject has multiple quizzes — the freshest read on direction.
      if (t.sourceSubject && q.attempts?.length) {
        const trend = quizTrend(q.attempts);
        if (trend) trendBySubject.set(t.sourceSubject, trend);
      }
    }
  }
  return Array.from(bySubject.entries()).map(([subject, { correct, seen }]) => ({
    subject, correctRate: correct / seen, attempts: seen, trend: trendBySubject.get(subject),
  }));
}

/** How many live (non-done/dismissed) tasks share each subject — feeds the "subject-balanced" ordering arm
 *  below, so a subject that already dominates the list doesn't also dominate the top of it. Pure, takes the
 *  task list as a plain argument. */
export function subjectFrequency(tasks: { sourceSubject?: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tasks) if (t.sourceSubject) out[t.sourceSubject] = (out[t.sourceSubject] || 0) + 1;
  return out;
}

/** The ordering-bandit's score adjustment (server/bandit.ts's ORDERING_ARMS) — layered on top of, never
 *  replacing, the existing Eisenhower score (sortWithinQuadrant, shared/types.ts). "urgency-first" changes
 *  nothing (today's plain behavior); "quick-wins-first" nudges tasks with fewer remaining steps up (a short
 *  task should not perpetually lose to a big one with a marginally higher score); "subject-balanced" nudges
 *  under-represented subjects up so one subject's backlog can't bury every other subject's tasks. Capped
 *  small (0.15, same ceiling as weakSubjectBoost) so this reorders WITHIN reason, never overrides a
 *  genuinely more urgent task from another quadrant. */
export function orderingBoost(task: { sourceSubject?: string; steps?: unknown[] }, armId: string, subjectFreq: Record<string, number>): number {
  if (armId === "quick-wins-first") {
    const n = task.steps?.length ?? 0;
    return Math.max(0, 0.15 - n * 0.03);
  }
  if (armId === "subject-balanced" && task.sourceSubject) {
    const freq = subjectFreq[task.sourceSubject] || 0;
    return Math.max(0, 0.15 - freq * 0.03);
  }
  return 0;
}

/** A small, explainable boost added to a task's existing Eisenhower score when its subject is one the
 *  student is currently struggling with — biases dashboard ORDERING toward what the pattern predicts is
 *  worth surfacing next, without replacing the existing urgency/importance ranking (see sortWithinQuadrant
 *  in shared/types.ts, which this is meant to layer on top of, not fight). Capped small (0.15) so a weak
 *  subject can move a task up within its quadrant, never override a genuinely more urgent one from another. */
export function weakSubjectBoost(task: { sourceSubject?: string }, weakSubjects: string[]): number {
  if (!task.sourceSubject) return 0;
  return weakSubjects.includes(task.sourceSubject) ? 0.15 : 0;
}

/** GTD's two-minute rule: if it genuinely takes two minutes or less, do it now instead of filing it away for
 *  later — direct instruction. `firstAction.minutes` (server/claude.ts's anti-procrastination "smallest
 *  possible first move", shared/types.ts) is Otto's own estimate of the smallest real action on this task;
 *  when that's ≤2 minutes, nudge the whole task up the same way weakSubjectBoost/orderingBoost do (same 0.15
 *  cap — this reorders WITHIN a quadrant, it never lets a two-minute chore outrank a genuinely urgent task
 *  from another one). The UI-visible ⚡ badge (TaskCard.tsx) is the other half of this — this is the half
 *  that actually changes where the task lands, not just how it's labeled. */
export function twoMinuteRuleBoost(task: { firstAction?: { minutes?: number } }): number {
  return (task.firstAction?.minutes ?? Infinity) <= 2 ? 0.15 : 0;
}

/** Ranks ready/actionable tasks by a blend of their own urgency/importance score and how soon they're due —
 *  the "what will the student probably act on next" prediction, layered on top of (never replacing) the
 *  existing Eisenhower quadrant/score already on each task. Deliberately simple: recency/deadline-weighted,
 *  no learned weights — the same reasoning as everywhere else in this layer (interpretable over clever). */
export function predictNextTasks(tasks: WebTask[], weakSubjects: string[] = [], now: Date = new Date()): WebTask[] {
  const scored = tasks.map((t) => {
    const dueMs = deadlineEpoch(t.when, now);
    const dueSoonBoost = Number.isFinite(dueMs) ? Math.max(0, 1 - (dueMs - now.getTime()) / (7 * 86_400_000)) * 0.3 : 0;
    const score = (t.score || 0) + dueSoonBoost + weakSubjectBoost(t, weakSubjects);
    return { task: t, score };
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.task);
}
