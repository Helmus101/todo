// A second pair of eyes on what the tutor TEACHES. Arithmetic is checked by code, but a wrong idea ("tension equals mg while the
// mass accelerates", "the pressure cap is because NH3 condenses") reads fluently and sails through every structural check.
// One cheap temperature-0 call lists claims that are DEFINITELY false; a flagged claim goes back through the normal repair step.
import { createTutorChat, usageOf } from "../claude.ts";

const TEACHING_MOVES = new Set(["explain", "worked_step", "worked_example", "correct_error", "hint_concept"]);

export function worthFactChecking(move: string, speech: string[], diagnosisStatus?: string): boolean {
  return (TEACHING_MOVES.has(move) || diagnosisStatus === "misconception") && speech.join(" ").split(/\s+/).length >= 18;
}

/** The first definitely-false claim in the reply, or null (also null when the check itself fails — it never blocks a reply). */
export async function falseClaim(speech: string[], boardTexts: string[], ctx: { subject?: string; problem?: string }, tokens: { in: number; out: number; cachedIn: number }): Promise<string | null> {
  if (process.env.TUTOR_FACTCHECK === "off") return null;
  try {
    const res = await createTutorChat({
      max_tokens: 400, temperature: 0, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: 'You check what a school tutor said for FACTUAL errors in maths, physics, chemistry, biology, economics, history, philosophy and literature. Report only a claim that is DEFINITELY false or a misleading simplification a student would carry away as a wrong rule (e.g. "tension equals mg" for an accelerating mass; a wrong cause; a wrong date or formula). Do NOT report style, incomplete explanations, teaching choices, questions, or anything you are unsure about. Return ONLY JSON: {"wrong": null} or {"wrong": "<the exact false claim and, in a few words, what is true>"}.' },
        { role: "user", content: `Subject: ${ctx.subject || "unknown"}${ctx.problem ? `\nProblem in play: ${ctx.problem.slice(0, 500)}` : ""}${boardTexts.length ? `\nBoard lines: ${boardTexts.join(" | ").slice(0, 500)}` : ""}\nThe tutor said: ${speech.join(" ")}` },
      ],
    }, true);
    const u = usageOf(res); tokens.in += u.in; tokens.out += u.out; tokens.cachedIn += u.cachedIn;
    const raw = String(res?.choices?.[0]?.message?.content || "");
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const w = typeof j?.wrong === "string" ? j.wrong.trim() : "";
    return w && w.toLowerCase() !== "null" ? w.slice(0, 240) : null;
  } catch { return null; }
}
