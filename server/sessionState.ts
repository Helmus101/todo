// THE APPLICATION-OWNED SESSION STATE — spec §18: "the LLM should not be responsible for maintaining this
// state by itself." Rebuilt deterministically, per turn, from signals the app already observes (which
// action got classified this turn — server/actionSpace.ts — and whether something independent happened:
// a problem solved, an objective ticked, a self-correction on the board), then handed to the model as
// read-only context (sessionStateBlock below).
//
// `mastery`/`liveMisconception`/`confidence`/`strategy` deliberately stay unset here — those depend on the
// still-disconnected per-concept student model (server/studentModel.ts); wiring that is a separate, larger
// pass (see the plan's "explicitly deferred" section). This module only ever uses signals that are already
// live: `task.mastery`, the turn's classified TutorAction, and whether the turn's own reaction (tutorAdapt.ts)
// read as frustrated.
import type { TutorAction } from "../shared/agentTypes.ts";
import { SESSION_CAP, SESSION_ACTION_CAP, type TutorSessionStateShape, type SessionAction } from "../shared/agentTypes.ts";
import type { Profile } from "../shared/types.ts";

export { SESSION_CAP, SESSION_ACTION_CAP };

function iso(now: Date): string { return now.toISOString(); }
function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

/** Actions that mean Otto stepped in rather than the student moving on their own — the two axes
 *  (hintRung/interventions) both key off this same small set, kept here so they can't drift apart. */
const INTERVENTION_ACTIONS = new Set<TutorAction>(["GIVE_HINT", "GIVE_TARGETED_HINT", "EXPLAIN", "SHOW_EXAMPLE"]);
/** How far up the 0-6 hint ladder a given action sits — a high-water mark (shared/agentTypes.ts's own
 *  doc comment on TutorSessionStateShape.hintRung), never decreasing within a session. */
function rungFor(action: TutorAction): number {
  switch (action) {
    case "GIVE_HINT": return 2;
    case "GIVE_TARGETED_HINT": return 4;
    case "EXPLAIN": case "SHOW_EXAMPLE": return 6;
    default: return 0;
  }
}

/** A brand-new session state for a task that has none yet — independence starts neutral (0.6, not 0: an
 *  untouched session hasn't proven dependence any more than it's proven independence) and every counter
 *  starts at 0. */
export function emptySessionState(taskId: string, now: Date): TutorSessionStateShape {
  return {
    taskId, updatedAt: iso(now), startedAt: iso(now), hintRung: 0, turns: 0, hintRequests: 0,
    answerSeeks: 0, unaidedSuccesses: 0, interventions: 0, independence: 0.6, frustration: 0,
    boardRichness: 0, recentActions: [],
  };
}

/** Find this task's session state, or start a fresh one — never mutates `profile`. */
export function loadOrInitSessionState(profile: Profile | undefined, taskId: string, now: Date): TutorSessionStateShape {
  const existing = profile?.tutorSessions?.find((s) => s.taskId === taskId);
  return existing || emptySessionState(taskId, now);
}

export interface SessionTurnSignals {
  action: TutorAction;
  /** From tutorAdapt.ts's Reaction, already computed live for the RL policy — just not persisted
   *  anywhere structured until now. */
  frustrated?: boolean;
  /** Board length AFTER this turn — normalized against ~12 entries (mirrors the existing `boardRich`
   *  context feature already fed into planTurn, tutorAdapt.ts). */
  boardLength: number;
  /** True when something independent happened this turn: a problem solved, an objective ticked, or a
   *  board self-correction (boardEvents.ts's selfCorrections) — the strongest signal this app can derive
   *  without the model self-reporting anything. */
  success: boolean;
  concept?: string;
  objective?: string;
  subproblem?: string;
}

/** Advance a session's state by one turn. Pure — the caller persists the result. */
export function updateSessionState(prev: TutorSessionStateShape, signals: SessionTurnSignals, now: Date): TutorSessionStateShape {
  const isIntervention = INTERVENTION_ACTIONS.has(signals.action);
  const hintRung = Math.max(prev.hintRung, rungFor(signals.action));
  // Small, deterministic nudge per turn rather than a ratio recomputed from scratch — an intervention
  // pulls independence down, a genuine success (not itself bought with an intervention this same turn)
  // pulls it up; both clamp to [0,1] so neither can run away.
  const independence = clamp01(prev.independence + (isIntervention ? -0.08 : signals.success ? 0.05 : 0));
  // Frustration decays toward 0 when the student isn't showing it, snaps up when they are — same EWMA-ish
  // shape as this codebase's other decayed signals (e.g. studentModel.ts's MASTERY_EWMA), just inlined
  // since this is the only place it's needed.
  const frustration = signals.frustrated ? clamp01(prev.frustration * 0.5 + 0.5) : clamp01(prev.frustration * 0.7);
  const action: SessionAction = {
    at: iso(now),
    kind: signals.action === "GIVE_HINT" || signals.action === "GIVE_TARGETED_HINT" ? "hint"
      : signals.action === "CREATE_PROBLEM" ? "problem"
      : "decision",
    detail: signals.action,
  };
  return {
    ...prev,
    updatedAt: iso(now),
    concept: signals.concept ?? prev.concept,
    subproblem: signals.subproblem ?? prev.subproblem,
    strategy: prev.strategy,
    hintRung,
    turns: prev.turns + 1,
    hintRequests: prev.hintRequests + (signals.action === "GIVE_HINT" || signals.action === "GIVE_TARGETED_HINT" ? 1 : 0),
    answerSeeks: prev.answerSeeks + (signals.action === "EXPLAIN" ? 1 : 0),
    unaidedSuccesses: prev.unaidedSuccesses + (signals.success && !isIntervention ? 1 : 0),
    interventions: prev.interventions + (isIntervention ? 1 : 0),
    independence,
    frustration,
    boardRichness: clamp01(signals.boardLength / 12),
    recentActions: [...prev.recentActions, action].slice(-SESSION_ACTION_CAP),
    nextRecommendedAction: prev.nextRecommendedAction,
  };
}

/** Upsert one task's session state into the profile's capped list (newest last, same shape as the other
 *  per-profile logs — e.g. recordTutorDecision in actionSpace.ts). Never mutates `profile`. */
export function persistSessionState(existing: TutorSessionStateShape[] | undefined, state: TutorSessionStateShape): TutorSessionStateShape[] {
  const rest = (existing || []).filter((s) => s.taskId !== state.taskId);
  return [...rest, state].slice(-SESSION_CAP);
}

/** A short prompt block — read-only context, not a log dump (spec §18: "the model interprets and
 *  decides" from structured state the app built, not from maintaining it itself). Omitted entirely on a
 *  session's very first turn (turns===0 going in — i.e. nothing to report yet). */
export function sessionStateBlock(state: TutorSessionStateShape): string {
  if (state.turns === 0) return "";
  const pct = (n: number) => `${Math.round(clamp01(n) * 100)}%`;
  return (
    `\nSESSION STATE (app-tracked, not your own memory — use it, don't recite it): turn ${state.turns + 1}, ` +
    `hint rung ${state.hintRung}/6 so far this session, independence ${pct(state.independence)}` +
    (state.frustration > 0.3 ? `, frustration reading ${pct(state.frustration)} — ease off, don't push harder` : "") +
    (state.interventions > 2 && state.independence < 0.4
      ? `. They've needed help ${state.interventions} times with low independence — look for a genuine win to hand back to them, not another hint.`
      : ".") +
    "\n"
  );
}
