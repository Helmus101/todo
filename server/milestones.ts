import type { TaskStep } from "../shared/types.ts";

// Same tiny Intl-based "calendar day in timezone X" helper as jobs.ts's own localDay — duplicated (not
// imported) to avoid a circular import: jobs.ts already imports replanMilestones FROM this file.
function localDay(now: Date, timezone?: string): string {
  try {
    // en-CA formats as YYYY-MM-DD, so this is the local calendar day in `timezone`.
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch { return now.toISOString().slice(0, 10); }
}

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
 *
 * `timezone` is the STUDENT's own IANA zone (Profile.timezone) — "today" here MUST be their local calendar
 * day, not the server's. This server runs in UTC; around midnight UTC (01:00-03:00 CET/CEST for a French
 * student) the server's UTC day and the student's local day genuinely disagree, so a bare
 * `now.toISOString().slice(0,10)` silently snapped/read "today" as the WRONG calendar day for roughly that
 * window every day — observed live as a milestone's targetDate landing on the day before it should (e.g.
 * showing Tuesday when it was meant to be Wednesday). Defaults to UTC only when no timezone is known.
 */
export function replanMilestones(steps: TaskStep[], now: Date = new Date(), timezone?: string): { steps: TaskStep[]; changed: boolean } {
  const todayKey = localDay(now, timezone);
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
