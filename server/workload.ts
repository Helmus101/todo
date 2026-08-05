import type { WebTask, Profile } from "../shared/types.ts";
import { isHandled, isLowGrade } from "../shared/types.ts";
import type { PronoteHomeworkItem, PronoteTestItem } from "./pronote.ts";
import { localDay } from "./jobs.ts";

/** One thing due/owed on a given day — a real Pronote homework/test, or an open Otto task. */
export interface WorkloadItem {
  kind: "homework" | "test" | "task";
  subject?: string;
  title: string;
  effort: number;
  taskId?: string;
  /** A task with no hard Pronote-sourced deadline — safe to nudge onto a lighter day. */
  movable?: boolean;
}
export interface WorkloadDay { date: string; items: WorkloadItem[]; totalEffort: number; }

const DAYS_AHEAD = 7;

function lowGradeSubjects(grades?: Profile["grades"]): Set<string> {
  const set = new Set<string>();
  for (const g of grades || []) if (isLowGrade(g.grade, g.scale)) set.add(g.subject.toLowerCase());
  return set;
}

/**
 * Deterministic, no-AI view of the week ahead: real Pronote homework/tests plus open Otto tasks,
 * bucketed by day with a relative "effort" heuristic (never presented as minutes — just relative
 * weight) so a student can see at a glance which day is actually heavy, not just what's due when.
 * Tests in a subject with a self-reported low grade (see isLowGrade) count for more, same "needs
 * more lead time" signal profileBlock/academicBlock already use for prompts (server/claude.ts).
 */
export function computeWorkload(input: {
  homework: PronoteHomeworkItem[];
  tests: PronoteTestItem[];
  tasks: WebTask[];
  grades?: Profile["grades"];
  /** The student's own IANA timezone (tzOf(profile)) — days are bucketed by THEIR local calendar day,
   *  not the server's, so a homework due "tonight" for them doesn't drift onto the wrong day. */
  timezone?: string;
  now?: Date;
}): { days: WorkloadDay[] } {
  const now = input.now || new Date();
  const tz = input.timezone || "UTC";
  const low = lowGradeSubjects(input.grades);

  const keys: string[] = [];
  const byDay = new Map<string, WorkloadItem[]>();
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const k = localDay(new Date(now.getTime() + i * 86_400_000), tz);
    keys.push(k);
    byDay.set(k, []);
  }
  const keySet = new Set(keys);
  const dayOf = (iso: string) => localDay(iso, tz);

  for (const h of input.homework) {
    const k = dayOf(h.deadline);
    if (!keySet.has(k)) continue;
    const effort = 1 + (h.description.length > 200 ? 0.5 : 0);
    byDay.get(k)?.push({ kind: "homework", subject: h.subject, title: h.description || h.subject, effort });
  }
  for (const t of input.tests) {
    const k = dayOf(t.deadline);
    if (!keySet.has(k)) continue;
    const mult = low.has(t.subject.toLowerCase()) ? 1.5 : 1;
    byDay.get(k)?.push({ kind: "test", subject: t.subject, title: t.subject, effort: 3 * mult });
  }
  // An open task with a real, parseable, in-window deadline lands on that day; anything else (soft/no
  // deadline) is treated as "on your plate now" and lands on today, same as the dashboard's active list.
  const todayKey = keys[0];
  for (const task of input.tasks) {
    if (isHandled(task.status)) continue;
    const dueTs = Date.parse(task.when || "");
    const dueKey = Number.isFinite(dueTs) ? dayOf(task.when!) : "";
    const hasFixedDue = !!dueKey && keySet.has(dueKey);
    const key = hasFixedDue ? dueKey : todayKey;
    const bucket = byDay.get(key);
    if (!bucket) continue;
    const undone = (task.steps || []).filter((s) => !s.done).length;
    bucket.push({ kind: "task", title: task.title, effort: Math.max(1, undone), taskId: task.id, movable: !hasFixedDue });
  }

  const days: WorkloadDay[] = keys.map((date) => {
    const items = byDay.get(date) || [];
    return { date, items, totalEffort: items.reduce((sum, it) => sum + it.effort, 0) };
  });
  return { days };
}

/** The lightest day in the window (excluding one date, e.g. the day a task is currently on) — where a
 *  movable task should be suggested to move to when its current day is overloaded. */
export function lightestDay(days: WorkloadDay[], excludeDate?: string): string | undefined {
  const candidates = days.filter((d) => d.date !== excludeDate);
  if (!candidates.length) return undefined;
  return candidates.reduce((a, b) => (b.totalEffort < a.totalEffort ? b : a)).date;
}

/** A day counts as a pile-up when it's meaningfully heavier than the week's typical BUSY day — the visual
 *  "early warning" signal (no separate notification/AI call needed). Baselined against days that actually
 *  have something due (not the whole week including empty days), since most weeks are mostly empty and a
 *  whole-week median/mean would sit at ~0 and never trigger. With fewer than 2 busy days to compare against,
 *  falls back to a fixed floor (one un-boosted test's worth of effort). */
export function isPileUp(day: WorkloadDay, days: WorkloadDay[]): boolean {
  if (day.totalEffort <= 0) return false;
  const busy = days.map((d) => d.totalEffort).filter((e) => e > 0).sort((a, b) => a - b);
  if (busy.length < 2) return day.totalEffort >= 3;
  const median = busy[Math.floor(busy.length / 2)];
  return day.totalEffort >= median * 1.6;
}
