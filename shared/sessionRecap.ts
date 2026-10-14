import type { BoardEntry, TaskObjective, TaskProblem } from "./types.ts";

interface SessionRecap {
  /** What they actually showed: objectives ticked and exercises they got right. */
  showed: string[];
  /** Still developing: objectives not reached and exercises left open. */
  developing: string[];
  /** Reusable strategies written on the board this session. */
  strategies: string[];
  /** One retrieval question for next time (spaced practice), or null. */
  reviewQuestion: string | null;
}

const short = (s: string, n = 90) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

/** The end-of-session coaching recap (CAiSEY-style "summary and coaching after every conversation"; the reflective
 *  close of expert tutoring), built in code from what the session really contains — no model call, nothing invented. */
export function buildSessionRecap(board: BoardEntry[], problems: TaskProblem[], objectives: TaskObjective[], en: boolean): SessionRecap {
  const showed = [
    ...objectives.filter((o) => o.done).map((o) => short(o.label)),
    ...problems.filter((p) => p.solved).map((p) => (en ? "Solved: " : "Réussi : ") + short(p.question, 70)),
  ].slice(0, 5);
  const developing = [
    ...objectives.filter((o) => !o.done).map((o) => short(o.label)),
    ...problems.filter((p) => !p.solved).map((p) => (en ? "Left open: " : "Laissé ouvert : ") + short(p.question, 70)),
  ].slice(0, 4);
  const strategies = board.filter((e) => e.kind === "strategy").map((e) => short(e.text, 100)).slice(-4);
  const definition = [...board].reverse().find((e) => e.kind === "definition" || e.kind === "formula");
  const solved = problems.find((p) => p.solved);
  const reviewQuestion = solved
    ? (en ? `Next time, without notes: ${short(solved.question, 120)}` : `La prochaine fois, sans notes : ${short(solved.question, 120)}`)
    : definition
      ? (en ? `Next time, from memory: write "${short(definition.text.replace(/\$[^$]*\$/g, "…"), 60)}" without looking.` : `La prochaine fois, de mémoire : réécris « ${short(definition.text.replace(/\$[^$]*\$/g, "…"), 60)} » sans regarder.`)
      : null;
  return { showed, developing, strategies, reviewQuestion };
}
