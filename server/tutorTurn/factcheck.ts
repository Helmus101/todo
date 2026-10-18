// A second pair of eyes on what the tutor TEACHES. Arithmetic is checked by code, but a wrong idea ("tension equals mg while the
// mass accelerates", "the pressure cap is because NH3 condenses") reads fluently and sails through every structural check.
// One cheap temperature-0 call lists claims that are DEFINITELY false; a flagged claim goes back through the normal repair step.
import { createTutorChat, usageOf } from "../claude.ts";

const TEACHING_MOVES = new Set(["explain", "worked_step", "worked_example", "correct_error", "hint_concept"]);

export function worthFactChecking(move: string, speech: string[], diagnosisStatus?: string, studentMessage = ""): boolean {
  const text = speech.join(" ");
  // Teaching moves and diagnoses, and ANY substantial reply that works with numbers (a "confirm" that agrees with a wrong figure is the commonest way an error gets validated).
  return (TEACHING_MOVES.has(move) || ["misconception", "slip", "partial"].includes(String(diagnosisStatus)) || /\d/.test(text) || ["confirm", "revoice", "recap"].includes(move) || (/[\d=^]/.test(studentMessage) && !/^\s*\[/.test(studentMessage))) && text.split(/\s+/).length >= 14;
}

/** The first definitely-false claim in the reply, or null (also null when the check itself fails — it never blocks a reply). */
export async function falseClaim(speech: string[], boardTexts: string[], ctx: { subject?: string; problem?: string; student?: string; recent?: string }, tokens: { in: number; out: number; cachedIn: number }): Promise<string | null> {
  if (process.env.TUTOR_FACTCHECK === "off") return null;
  try {
    const res = await createTutorChat({
      max_tokens: 400, temperature: 0, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: 'You check what a school tutor said for FACTUAL errors in maths, physics, chemistry, biology, economics, history, philosophy and literature. Report only a claim that is DEFINITELY false or a misleading simplification a student would carry away as a wrong rule (e.g. "tension equals mg" for an accelerating mass; a wrong cause; a wrong date or formula). ALSO report it when the tutor says or implies the answer given by the student is RIGHT (for example calling it the first term, or saying exactly or correct) but what the student said is actually wrong or is not what the tutor claims it is. ALSO report it when the tutor says or implies the STUDENT made an error, misconception or wrong step but what the student said (given below) is actually correct. Check every number the tutor confirms or states against the set-up in the conversation (e.g. a shortfall of 85 − 80 is 5, not 20). Do NOT report style, incomplete explanations, teaching choices, questions, or anything you are unsure about. Return ONLY JSON: {"wrong": null} or {"wrong": "<the exact false claim and, in a few words, what is true>"}.' },
        { role: "user", content: `Subject: ${ctx.subject || "unknown"}${ctx.problem ? `\nProblem in play: ${ctx.problem.slice(0, 500)}` : ""}${ctx.recent ? `\nThe conversation so far (for the numbers and set-up): ${ctx.recent.slice(0, 900)}` : ""}${boardTexts.length ? `\nBoard lines: ${boardTexts.join(" | ").slice(0, 500)}` : ""}\n${ctx.student ? `The student said: ${ctx.student.slice(0, 400)}\n` : ""}The tutor said: ${speech.join(" ")}` },
      ],
    }, true);
    const u = usageOf(res); tokens.in += u.in; tokens.out += u.out; tokens.cachedIn += u.cachedIn;
    const raw = String(res?.choices?.[0]?.message?.content || "");
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const w = typeof j?.wrong === "string" ? j.wrong.trim() : "";
    return w && w.toLowerCase() !== "null" ? w.slice(0, 240) : null;
  } catch { return null; }
}
