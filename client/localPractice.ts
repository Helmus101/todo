import type { DailyPracticeProblem } from "../shared/types.ts";

const KEY = "otto-local-practice";

type StoredPractice = { taskId: string; problem: DailyPracticeProblem; savedAt: string };

function readAll(): Record<string, StoredPractice> {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}

export function savePracticeLocally(taskId: string, problem: DailyPracticeProblem): void {
  if (!problem?.id) return;
  try {
    const all = readAll();
    all[problem.id] = { taskId, problem, savedAt: new Date().toISOString() };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* local backup is best-effort */ }
}

export function getLocalPractice(problemId: string): DailyPracticeProblem | null {
  return readAll()[problemId]?.problem || null;
}
