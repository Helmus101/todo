// THE TUTOR KNOWS THE ANSWER. Before Otto guides a student through a problem, this works the problem out once —
// in a separate, focused model call — and code checks the result. The tutor then steers every turn from a VERIFIED
// solution instead of re-deriving the maths inside each reply (which is how it used to doubt right answers and
// invent numbers). The solution never leaves the server (outgoingTasks strips it; finished tasks drop it).
import type { TutorSolution } from "../shared/types.ts";
import { createTutorChat, retryRequest, usageOf } from "./claude.ts";
import { evalCheckFor } from "./tutorAdapt.ts";

/** Is `stated` really a NEW problem, or just the student working on the current one with its numbers ("so 900 times
 *  9.8 times sin 12… find the force")? New when most of its numbers are not in the current problem. Pure. */
export function isNewProblem(stated: string, current: TutorSolution | undefined): boolean {
  if (!current) return true;
  const nums = (x: string) => (String(x || "").replace(/(?!(?<![\d.,])0)(\d)[,\s](?=\d{3}(?!\d))/g, "$1").match(/\d+(?:\.\d+)?/g) || []);
  const mine = nums(stated), theirs = new Set(nums(current.statement));
  if (!mine.length) return false;
  return mine.filter((n) => !theirs.has(n)).length / mine.length > 0.5;
}

/** Normalized identity of a problem statement — the same problem asked twice is one solve. */
export function focusKeyOf(statement: string): string {
  return String(statement || "").toLowerCase().replace(/\$|\\[a-z]+/g, " ").replace(/[^a-z0-9.°%]+/g, " ").trim().slice(0, 240);
}

const SOLVER_PROMPT = `You are an expert teacher preparing to tutor ONE problem. Solve it completely and carefully, then return ONLY a JSON object:
{
  "final_answer": "the answer with its unit, e.g. \\"25538 W\\" or \\"x = 4\\" (for an open question: a one-sentence model answer)",
  "check": "an arithmetic expression that COMPUTES the numeric final answer from the givens, using + - * / ^ ( ) sqrt sin cos tan asin acos atan ln log exp pi — use sind/cosd/tand for degrees (e.g. \\"(900*9.8*sind(12)+900*0.4+360)*10\\"); empty string if the answer isn't a number",
  "steps": [ { "idea": "what this step does and why (one line)", "result": "what it gives, e.g. \\"F = 2553.8 N\\"", "check": "expression computing this step's number, or empty" } ],
  "key_idea": "the one idea that unlocks the problem",
  "alternatives": ["another valid method, one line each"],
  "mistakes": ["a common wrong move a student makes here, and why it's wrong"],
  "skill": "a short name for the skill practiced, e.g. \\"power on an incline\\""
}
Use the givens exactly as stated. 2-6 steps. Be precise: these values will be used to check the student's work.`;

function firstJson(raw: string): any {
  const t = String(raw || "");
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fence ? fence[1] : t;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

const num = (s: string): number => Number(String(s || "").replace(/(?!(?<![\d.,])0)(\d)[,\s](?=\d{3}(?!\d))/g, "$1").replace(",", ".").match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/i)?.[0] ?? NaN);

/** Build a TutorSolution from the solver's JSON, verifying numbers by code. Pure; exported for tests. */
export function toSolution(statement: string, j: any, now = new Date()): TutorSolution | null {
  if (!j || typeof j !== "object") return null;
  const finalAnswer = String(j.final_answer || "").trim().slice(0, 200);
  if (!finalAnswer) return null;
  const check = String(j.check || "").trim();
  const value = check ? evalCheckFor(check, statement) : null;
  const stated = num(finalAnswer);
  // Verified when code computes the same number the solver stated (1%), or when the answer isn't numeric at all.
  const numeric = Number.isFinite(stated) || !!check;
  const verified = !numeric || (value != null && Number.isFinite(stated) && Math.abs(stated - value) <= Math.max(0.01, Math.abs(value) * 0.01));
  const steps = (Array.isArray(j.steps) ? j.steps : []).slice(0, 8).map((st: any) => {
    const v = st?.check ? evalCheckFor(String(st.check), statement) : null;
    return { idea: String(st?.idea || "").slice(0, 200), ...(st?.result ? { result: String(st.result).slice(0, 120) } : {}), ...(v != null && Number.isFinite(v) ? { value: v } : {}) };
  }).filter((st: { idea: string }) => st.idea);
  const list = (x: unknown) => (Array.isArray(x) ? x.map((y) => String(y || "").slice(0, 200)).filter(Boolean).slice(0, 4) : []);
  return {
    focusKey: focusKeyOf(statement), statement: statement.slice(0, 1200), finalAnswer,
    ...(value != null && Number.isFinite(value) ? { value } : {}),
    verified, steps,
    ...(j.key_idea ? { keyIdea: String(j.key_idea).slice(0, 200) } : {}),
    alternatives: list(j.alternatives), mistakes: list(j.mistakes),
    ...(j.skill ? { skill: String(j.skill).slice(0, 60) } : {}),
    at: now.toISOString(),
  };
}

/** Solve a problem (one model call, a second one if code disagrees with the first answer). Never throws: returns
 *  null when the model fails, so a tutor turn always goes ahead. */
export async function solveProblem(statement: string, subject?: string): Promise<{ solution: TutorSolution | null; tokens: { in: number; out: number; cachedIn: number } }> {
  const tokens = { in: 0, out: 0, cachedIn: 0 };
  let best: TutorSolution | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res: any = await retryRequest(() => createTutorChat({
        max_tokens: 4000, temperature: 0.1,
        messages: [
          { role: "system", content: SOLVER_PROMPT },
          { role: "user", content: `${subject ? `Subject: ${subject}\n` : ""}Problem: ${statement}${attempt ? "\n\nYour previous final_answer did not match your own check expression. Recompute carefully, step by step." : ""}` },
        ],
      }, true), 2, 400); // bounded per attempt (createTutorChat's fast mode) — a stalled provider never holds the turn
      const u = usageOf(res); tokens.in += u.in; tokens.out += u.out; tokens.cachedIn += u.cachedIn;
      const sol = toSolution(statement, firstJson(res?.choices?.[0]?.message?.content || ""));
      if (sol) best = sol;
      if (sol?.verified) break;
    } catch (e: any) {
      console.warn(`[solver] failed: ${e?.message || e}`);
      break;
    }
  }
  // Code computed the number but the stated answer disagreed twice: trust the computed value.
  if (best && !best.verified && best.value != null) best = { ...best, finalAnswer: String(Math.round(best.value * 1e4) / 1e4), verified: true };
  return { solution: best, tokens };
}

/** The hidden prompt block: the tutor steers by this, never reveals it. */
export function solutionBlock(sol: TutorSolution | undefined | null): string {
  if (!sol) return "";
  const steps = sol.steps.map((s, i) => `  ${i + 1}. ${s.idea}${s.result ? ` → ${s.result}` : ""}`).join("\n");
  return `\n\nWORKED SOLUTION — FOR YOU ONLY (${sol.verified ? "verified by code" : "NOT verified: recompute before trusting a number"}). Never reveal it, never state a step's result before the student reaches it; use it to know where they are, what's right, and the next small step. It applies ONLY while the student is working on this problem: if the conversation has moved to another topic, ignore this block entirely.\n` +
    `Problem: ${sol.statement.slice(0, 400)}\n` +
    `Answer: ${sol.finalAnswer}\n` +
    (steps ? `Steps:\n${steps}\n` : "") +
    (sol.keyIdea ? `Key idea: ${sol.keyIdea}\n` : "") +
    (sol.alternatives?.length ? `Other valid methods (accept them): ${sol.alternatives.join(" | ")}\n` : "") +
    (sol.mistakes?.length ? `Common mistakes to watch for: ${sol.mistakes.join(" | ")}\n` : "");
}

/** Every number the solution produces (final + steps) — a student saying one of them has reached that point. */
export function solutionValues(sol: TutorSolution | undefined | null): number[] {
  if (!sol) return [];
  return [sol.value, ...sol.steps.map((s) => s.value)].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}
