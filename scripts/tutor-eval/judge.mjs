// LLM-as-judge for one transcript: temperature 0, JSON out. A judge is a noisy instrument — the scores are for comparing
// before/after on the SAME scenarios, and the worst turns it quotes are for a human to read.
import { createTutorChat, usageOf, addSpend } from "./lib.mjs";

const DIMS = ["responds", "diagnosis", "help_level", "explanation", "variety_level", "student_thinks", "accuracy", "human_feel"];

function render(S, scenario) {
  const lines = [];
  S.turns.forEach((t, i) => {
    if (t.error) { lines.push(`[turn ${i}] (tutor error — no reply)`); return; }
    lines.push(`[turn ${i}] STUDENT: ${t.message}`);
    const mv = t.turn ? ` {move: ${t.turn.move}, support: ${t.turn.support}, diagnosis: ${t.turn.diagnosis}${t.turn.misconception ? `, misconception: "${t.turn.misconception}"` : ""}${t.turn.angle ? `, angle: ${t.turn.angle}` : ""}}` : "";
    lines.push(`[turn ${i}] TUTOR${mv}: ${t.reply}`);
    const b = (t.newBoard || []).map((e) => `${e.kind}${e.owner === "student" ? "/student" : ""}: ${String(e.text || "").replace(/\s+/g, " ").slice(0, 200)}`);
    if (b.length) lines.push(`   board+: ${b.join(" | ")}`);
    for (const p of t.newProblems || []) lines.push(`   exercise: ${String(p.question).replace(/\s+/g, " ").slice(0, 900)}${p.options?.length ? ` [options: ${p.options.join(" / ").slice(0, 120)}]` : ""}`);
  });
  return lines.join("\n");
}

/** The same rendering for a transcript saved in results.jsonl (strings instead of objects). */
export function renderSaved(transcript) {
  const lines = [];
  transcript.forEach((t, i) => {
    if (t.error) { lines.push(`[turn ${i}] (tutor error — no reply)`); return; }
    lines.push(`[turn ${i}] STUDENT: ${t.student}`);
    lines.push(`[turn ${i}] TUTOR {move: ${t.move}, support: ${t.support}, diagnosis: ${t.diagnosis}${t.misconception ? `, misconception: "${t.misconception}"` : ""}${t.angle ? `, angle: ${t.angle}` : ""}}: ${t.tutor}`);
    if ((t.board || []).length) lines.push(`   board+: ${t.board.join(" | ")}`);
    for (const q of t.exercises || []) lines.push(`   exercise: ${String(q).replace(/\s+/g, " ").slice(0, 900)}`);
  });
  return lines.join("\n");
}

/** Two independent passes averaged (a single judge call swings a scenario by up to a point); a hard fail needs both. */
export async function judge(S, scenario, saved) {
  const passes = Number(process.env.EVAL_JUDGE_PASSES || 2);
  const rs = [];
  for (let i = 0; i < passes; i++) rs.push(await judgeOnce(S, scenario, saved));
  const ok = rs.filter((r) => !r.error && r.mean);
  if (!ok.length) return rs[0];
  const scores = Object.fromEntries(DIMS.map((d) => [d, Math.round((ok.reduce((n, r) => n + r.scores[d], 0) / ok.length) * 100) / 100]));
  const first = ok[0];
  return { ...first, scores, mean: Math.round((DIMS.reduce((n, d) => n + scores[d], 0) / DIMS.length) * 100) / 100, hard_fail: ok.every((r) => r.hard_fail), hard_fail_reason: ok.find((r) => r.hard_fail)?.hard_fail_reason || "", worst_turns: ok.flatMap((r) => r.worst_turns || []).slice(0, 4), summary: ok.map((r) => r.summary).join(" | "), passes: ok.length };
}

async function judgeOnce(S, scenario, saved) {
  const sys = `You are a strict evaluator of an AI tutor ("Otto") for secondary-school students (IB / bac). You read one tutoring transcript and score it. The ideal tutor is a great human teacher: adaptive, Socratic (the student does the thinking), creative, and it ACTUALLY EXPLAINS plainly when the student is lost or asks why; it diagnoses the belief behind a mistake and tests it with a fresh case; it asks a variety of questions at the student's level; it uses the board for what must stay visible; it never gives away answers to open problems, never invents facts, never repeats itself, and stays warm without filler praise.

Scenario: ${scenario.id} (${scenario.subject}, language ${scenario.lang}).
What a great tutor does here: ${scenario.expect}

Score 1-5 (5 = a top human tutor, 3 = acceptable but flawed, 1 = harmful or useless) on:
- responds: answers what the student actually said/asked each time (no ignored right answers, no ignored "why", no topic dodging)
- diagnosis: finds and names the actual misconception or slip, and tests it rather than just telling
- help_level: the right amount of help each turn (not too much too soon, not funnelling leading questions, not leaving a stuck student alone)
- explanation: when explanation is needed it is clear, correct, concrete, and uses a NEW angle if the first did not land
- variety_level: questions and exercises vary in kind and are at the student's level (rising when they succeed, easier when they struggle)
- student_thinks: the student does the reasoning; the tutor does not do the work or hand over the answer
- accuracy: every maths/science/humanities claim is correct (flag any wrong fact exactly)
- human_feel: sounds like a real, caring teacher talking to THIS student: reacts to what they said and how they feel, uses their own words, varies its openers and sentence shapes, is sometimes brief, never templated ("Now the real question…" every turn, "Exactly right" every turn), never lectures when a short human reply would do. Robotic, repetitive or over-polished = 1-2

Also report: "hard_fail": true if the tutor gave the final answer to an open problem before the student reached it, wrote the student's graded work (an essay, a full solution), invented a fact/quote/source, said something factually wrong, or showed tool syntax; "worst_turns": up to 3 objects {turn, why} quoting the exact problem; "best_turn": {turn, why}; "summary": two sentences on what to fix first.
Return ONLY JSON: {"responds":n,"diagnosis":n,"help_level":n,"explanation":n,"variety_level":n,"student_thinks":n,"accuracy":n,"human_feel":n,"hard_fail":bool,"hard_fail_reason":"","worst_turns":[{"turn":0,"why":""}],"best_turn":{"turn":0,"why":""},"summary":""}`;
  const user = saved ? renderSaved(saved) : render(S, scenario);
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // fast = thinking off: a reasoning model otherwise spends the whole token budget thinking and returns nothing.
      const res = await createTutorChat({ max_tokens: 2500, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }, true);
      addSpend(usageOf(res));
      const raw = String(res?.choices?.[0]?.message?.content || "");
      const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      const scores = Object.fromEntries(DIMS.map((d) => [d, Math.max(1, Math.min(5, Number(j[d]) || 0))]));
      if (!DIMS.every((d) => Number(j[d]) >= 1)) throw new Error("missing scores");
      return { ...j, scores, mean: Math.round((DIMS.reduce((n, d) => n + scores[d], 0) / DIMS.length) * 100) / 100 };
    } catch (e) { lastErr = String(e?.message || e); }
  }
  return { error: lastErr, scores: {}, mean: 0 };
}
export { DIMS, render };
