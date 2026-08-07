import type { TaskStep } from "../shared/types.ts";

/**
 * Deterministic, no-AI re-plan for a big IB project's milestone steps (Extended Essay, TOK, CAS, an IA —
 * see `isBigIbProject` in server/claude.ts, which is the only place `targetDate` ever gets set on a step).
 * Ordinary tasks' steps never have `targetDate`, so this is a no-op for them.
 *
 * Walks the steps in order. The first UNDONE step whose `targetDate` is in the past snaps to today (it's
 * due now) and records how many days it slipped by; every undone step AFTER it shifts by that same amount,
 * preserving the original spacing between milestones instead of bunching them all onto today. No AI call —
 * same reasoning as workload.ts's `computeWorkload`: this is pure date arithmetic, and calling a model to
 * re-date a checklist would just be slower and less predictable for no benefit.
 */
export function replanMilestones(steps: TaskStep[], now: Date = new Date()): { steps: TaskStep[]; changed: boolean } {
  const todayKey = now.toISOString().slice(0, 10);
  let changed = false;
  let slipDays = 0;
  const out = steps.map((s) => ({ ...s }));
  for (const s of out) {
    if (!s.targetDate || s.done) continue;
    if (slipDays > 0) {
      const d = new Date(`${s.targetDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + slipDays);
      s.targetDate = d.toISOString().slice(0, 10);
      changed = true;
      continue;
    }
    if (s.targetDate < todayKey) {
      const missedByMs = now.getTime() - new Date(`${s.targetDate}T00:00:00Z`).getTime();
      slipDays = Math.max(1, Math.round(missedByMs / 86_400_000));
      s.targetDate = todayKey;
      changed = true;
    }
  }
  return { steps: out, changed };
}
