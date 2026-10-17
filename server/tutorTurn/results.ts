// WHAT THE ANSWER WIDGET AND THE BOARD'S ANSWER BOXES REPORT — parsed from the "[Exercise] …" messages the client sends
// (client/tutor/TutorSession.tsx: onProblemResult / onGapCheck, English and French, several results batched one per line).
// Until now only the evidence recorder read these; the policy, the session guide, the adaptation lines and the difficulty
// never saw an exercise outcome, so a right widget answer never triggered "make it solid" and a wrong one never counted
// as a struggle. Pure.

export type ResultVerdict = "correct" | "incorrect" | "partial" | "ungraded";
export interface ExerciseResult {
  /** An exercise in the answer widget, or a line the student answered in the board's own box. */
  source: "widget" | "gap";
  verdict: ResultVerdict;
  /** Which try this was (widget only). */
  attempt?: number;
  given?: string;
}

const HEAD = /^\s*\[(?:Exercise|Exercice)\]\s*/i;
const quoted = (s: string) => /["«]\s*([\s\S]*?)\s*["»]/.exec(s)?.[1];

export function parseExerciseResults(message: string): ExerciseResult[] {
  const out: ExerciseResult[] = [];
  for (const line of String(message || "").split("\n")) {
    if (!HEAD.test(line)) continue;
    const body = line.replace(HEAD, "");
    const attempt = Number(/(?:try #|essai n°)\s*(\d+)/i.exec(body)?.[1]) || undefined;
    const gap = /^(?:On the board line|Au tableau)/i.test(body);
    // The student's own text sits inside the quotes; the verdict is what follows the last "—".
    const tail = body.slice(body.lastIndexOf("—") + 1);
    const given = gap ? [...body.matchAll(/["«]\s*([\s\S]*?)\s*["»]/g)][1]?.[1] : quoted(body);
    let verdict: ResultVerdict;
    if (/NOT graded|non noté/i.test(tail)) verdict = "ungraded";
    else if (/PARTLY|en partie/i.test(tail)) verdict = "partial";
    else if (/couldn'?t be auto-checked|non vérifiable/i.test(tail)) verdict = "ungraded";
    else if (/marked wrong|checked wrong|\bfaux\b|vérifié faux/i.test(tail)) verdict = "incorrect";
    else if (/marked right|checked right|\bjuste\b|vérifié juste/i.test(tail)) verdict = "correct";
    else continue;
    out.push({ source: gap ? "gap" : "widget", verdict, ...(attempt ? { attempt } : {}), ...(given ? { given } : {}) });
  }
  return out;
}

/** The verdict the policy and guide should treat this message as: the LAST gradable result wins. A partial answer is not
 *  right (it still needs the missing piece), so it counts as incorrect for support and adaptation. */
export function verdictFromResults(results: ExerciseResult[]): "correct" | "incorrect" | undefined {
  const last = [...results].reverse().find((r) => r.verdict !== "ungraded");
  if (!last) return undefined;
  return last.verdict === "correct" ? "correct" : "incorrect";
}
