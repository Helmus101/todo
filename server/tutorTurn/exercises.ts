// EVERY EXERCISE IS NEW — Otto sees only the last few messages, so a question he asked ten turns ago (or in a past
// session) is invisible to him and comes back word for word. This keeps the full list of exercises already used this
// session (and the ones in the on-device memory) and compares a new one against it. Pure.
import type { BoardEntry, TaskProblem } from "../../shared/types.ts";

const MAX_LIST = 12;

/** Letters and numbers apart ("2sin(3x)" → 2 sin 3 x), plus adjacent pairs, so 2sin(3x) and 3cos(2x) don't look alike. */
function grams(text: string): Set<string> {
  const t = String(text || "").toLowerCase().replace(/\\(?:left|right|cdot|times|sin|cos|tan|frac|sqrt)\b/g, (m) => m.replace("\\", " ")).match(/[a-zà-ÿ]+|\d+(?:[.,]\d+)?/g) || [];
  const stop = new Set(["what", "how", "do", "does", "you", "the", "a", "an", "is", "are", "of", "to", "and", "your", "get", "this", "that", "for", "from", "with", "quel", "quelle", "est", "le", "la", "les", "de", "du"]);
  const w = t.filter((x) => !stop.has(x));
  const out = new Set<string>(w);
  for (let i = 0; i < w.length - 1; i++) out.add(`${w[i]}_${w[i + 1]}`);
  return out;
}

export function sameExercise(a: string, b: string, threshold = 0.5): boolean {
  const A = grams(a), B = grams(b);
  if (A.size < 5 || B.size < 5) return false;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter) >= threshold;
}

/** One text contains most of the other's content (an old problem quoted inside a longer reply). */
export function mostlyContains(longer: string, problem: string, threshold = 0.5): boolean {
  const A = grams(longer), B = grams(problem);
  if (B.size < 6) return false;
  let inter = 0;
  for (const g of B) if (A.has(g)) inter++;
  return inter / B.size >= threshold;
}

const hasMaths = (s: string) => /\d|\$|\\[a-z]+|[=^]/.test(s);
const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 120);

/** Exercise-like prompts Otto has already set: every problem, every maths-bearing question he asked anywhere in the full
 *  history, and what the on-device memory says earlier sessions used. Newest last, de-duplicated, capped. */
export function exercisesSoFar(i: { history: { role: string; text: string }[]; problems: TaskProblem[]; memory?: { done?: string[] }[]; board?: BoardEntry[] }): string[] {
  const all: string[] = [];
  for (const m of i.memory || []) for (const d of m.done || []) all.push(clip(d));
  for (const h of i.history) {
    if (h.role !== "assistant") continue;
    const qs = String(h.text || "").replace(/\s+/g, " ").match(/[^.!?]*[^.!?\s][^.!?]*\?/g) || [];
    for (const q of qs) if (hasMaths(q) && q.trim().split(/\s+/).length >= 5) all.push(clip(q));
  }
  for (const p of i.problems) if (p.question) all.push(clip(p.question));
  for (const b of i.board || []) if (b.kind === "given" && b.text && b.text.split(/\s+/).length >= 12) all.push(clip(b.text));
  const out: string[] = [];
  for (const e of all) if (e && !out.some((o) => sameExercise(o, e))) out.push(e);
  return out.slice(-MAX_LIST);
}

/** The earlier exercise a new prompt repeats, if any. */
export function repeatedExercise(prompt: string, used: string[], threshold = 0.5): string | null {
  return used.find((u) => sameExercise(u, prompt, threshold)) ?? null;
}

export function exercisesBlock(used: string[]): string {
  if (!used.length) return "";
  return `EXERCISES ALREADY USED (this session and earlier ones): ${used.map((u) => `"${u}"`).join(" · ")}. Never set one of these again, nor the same with trivial changes. The next exercise must change the function or the numbers AND the situation, and either sit one step up in difficulty or test the same skill a different way (compute / spot the error / sketch / explain).`;
}

export type QuestionKind = "spot_error" | "explain_why" | "sketch" | "predict" | "compare" | "compute" | "recall";

/** What kind of task a question sets — so the next one can be a different kind. */
export function questionKind(q: string): QuestionKind {
  const t = String(q || "").toLowerCase();
  if (/\b(?:error|mistake|wrong|spot|went wrong|erreur|faute)\b/.test(t)) return "spot_error";
  // A worked solution shown for checking ("A student analyses … Their working is shown below: Line 1: …") IS an error-spotting item, even when it never says "error".
  if (/\b(?:working is shown|worked solution|their working|his working|her working|(?:a|the) student (?:solves|analy[sz]es|calculates|writes|claims|works out|attempts)|sa r[ée]solution|son raisonnement)\b|(?:^|\s)line\s*[1-5]\s*:|ligne\s*[1-5]\s*:/.test(t)) return "spot_error";
  if (/\b(?:sketch|draw|graph|plot|dessine|trace)\b/.test(t)) return "sketch";
  if (/\bwhy\b|\bexplain\b|\bhow come\b|pourquoi|expliqu/.test(t)) return "explain_why";
  if (/\b(?:what happens|what would happen|predict|what if|que se passe)\b/.test(t)) return "predict";
  if (/\b(?:compare|difference|versus|vs\.?|which is (?:larger|bigger|greater|better))\b/.test(t)) return "compare";
  if (/\d|\$|[=^]/.test(t)) return "compute";
  return "recall";
}

/** The kinds of question Otto asked in his last few messages (newest last). */
export function recentQuestionKinds(history: { role: string; text: string }[], n = 4): QuestionKind[] {
  const kinds: QuestionKind[] = [];
  for (const h of history) {
    if (h.role !== "assistant") continue;
    const qs = String(h.text || "").replace(/\s+/g, " ").match(/[^.!?]*[^.!?\s][^.!?]*\?/g) || [];
    const last = qs[qs.length - 1];
    if (last && last.trim().split(/\s+/).length >= 3) kinds.push(questionKind(last));
  }
  return kinds.slice(-n);
}

/** The next kind of exercise to set: calculation stays the workhorse (about one in three), every other kind rotates by least-recently-used, and
 *  "spot the error in a worked solution" is a once-in-a-while change of pace (never within the last five exercises). Oldest first in `kinds`. */
export function pickNextKind(kinds: QuestionKind[], opts: { sketch?: boolean } = {}): QuestionKind {
  const recent2 = kinds.slice(-2);
  if (!recent2.includes("compute")) return "compute";
  const order: QuestionKind[] = ["explain_why", "predict", "compare", ...(opts.sketch === false ? [] : ["sketch" as QuestionKind]), "spot_error"];
  const eligible = order.filter((k) => !recent2.includes(k) && !(k === "spot_error" && kinds.slice(-5).includes("spot_error")));
  const pool = eligible.length ? eligible : order.filter((k) => !recent2.includes(k) && k !== "spot_error");
  const lastUse = (k: QuestionKind) => kinds.lastIndexOf(k);
  return [...(pool.length ? pool : (["explain_why"] as QuestionKind[]))].sort((a, b) => lastUse(a) - lastUse(b) || order.indexOf(a) - order.indexOf(b))[0];
}

export function varietyLine(kinds: QuestionKind[]): string {
  if (kinds.length < 2) return "";
  const all: QuestionKind[] = ["compute", "explain_why", "spot_error", "sketch", "predict", "compare"];
  const fresh = all.filter((k) => !kinds.includes(k) && (k !== "spot_error" || !kinds.length));
  return `QUESTION VARIETY: your last questions were: ${kinds.join(", ")}. ${fresh.length ? `Use a kind you haven't used lately — ${fresh.join(" / ")}.` : "Change the kind of task again."} (compute = work out a value; explain_why = give the reason; spot_error = find the mistake in a worked line; sketch = draw/graph it; predict = what happens if something changes; compare = how two things differ.)`;
}
