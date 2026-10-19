// Grades one answer to a tutor exercise on the SERVER: the browser sends the question, the answer and the sealed key token; the key is opened here
// (never sent to the student), the shared grader decides, and only what the student has earned comes back — the explanation and the correct option
// appear only once they are right, a miss never reveals anything.
import { gradeExerciseAnswer, gradeConceptAnswer } from "../../shared/exerciseVerification.ts";
import { problemIsPercent } from "../../shared/types.ts";
import type { TaskProblem } from "../../shared/types.ts";
import { unsealKey } from "./keySeal.ts";

export interface CheckResponse { status: number; json: Record<string, unknown> }

export function checkProblemAnswer(user: string, body: any, fr: boolean): CheckResponse {
  const id = typeof body?.problemId === "string" ? body.problemId.slice(0, 64) : "";
  const given = typeof body?.answer === "string" ? body.answer.slice(0, 600) : "";
  const question = typeof body?.question === "string" ? body.question.slice(0, 600) : "";
  if (!id || !question) return { status: 400, json: { error: "Incomplete request." } };
  if (!given.trim()) return { status: 400, json: { error: "Write an answer first." } };
  const keys = unsealKey(body?.keyToken, user, id);
  if (!keys) return { status: 410, json: { error: "This exercise can't be checked any more — ask Otto for a new one.", code: "key_expired" } };
  const options = Array.isArray(body?.options) ? body.options.map((o: unknown) => String(o).slice(0, 300)).slice(0, 6) : undefined;
  const problem: TaskProblem = { id, createdAt: "", question, ...(options?.length ? { options } : {}), ...(typeof body?.format === "string" ? { format: body.format.slice(0, 200) } : {}), ...keys };
  const isMcq = !!options && options.length >= 2 && Number.isInteger(keys.correct);
  const grade = gradeExerciseAnswer(problem, given, { percent: problemIsPercent(problem) });
  const out: Record<string, unknown> = { status: grade.status };
  if (grade.status === "correct") {
    if (isMcq) out.correct = Number(given.trim());
    if (keys.why) out.why = keys.why;
  } else if (grade.status === "incorrect" || grade.status === "partially_correct") {
    const miss = conceptMiss(problem, given, fr);
    if (miss) out.miss = miss;
  }
  return { status: 200, json: out };
}

/** A worded answer's specific miss message (an idea is missing / a related idea) — never the model answer. */
function conceptMiss(p: TaskProblem, given: string, fr: boolean): string | null {
  if (!p.rubric?.required?.length || !given.trim()) return null;
  const g = gradeConceptAnswer(p.rubric, given);
  if (g.status === "partially_correct") return `Partly right — you have ${g.met} of the ${g.total} key ideas. What's still missing?`;
  if (g.misconception) return `"${g.misconception}" is a related idea, but it isn't what's being asked here. Try again.`;
  return null;
}
