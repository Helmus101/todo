// Runs the regression scenarios (tests/tutorScenarios.ts) against the REAL tutor model and board writer.
//   npm run eval:tutor                 all scenarios
//   npm run eval:tutor -- --only <id>  one scenario        (add --runs 3 to repeat each one, since models vary run to run)
// Needs API keys in .env (GEMINI_API_KEY and/or DEEPSEEK_API_KEY) and costs a few cents. The tutor scenarios use the typed
// tutor model as a stand-in for the live voice model, which behaves similarly but is not identical. Exit code 1 if any fail.
import "../server/env.ts";
import { createTutorChat } from "../server/claude.ts";
import { liveInstructions } from "../shared/liveTutor.ts";
import { writeBoard } from "../server/tutorTurn/boardWriter.ts";
import { SCENARIOS, validateScenarios, type Scenario } from "../tests/tutorScenarios.ts";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const only = arg("--only");
const runs = Math.max(1, Number(arg("--runs")) || 1);

const bad = validateScenarios();
if (bad.length) { console.error("The scenarios themselves are broken:\n" + bad.join("\n")); process.exit(2); }
if (!process.env.GEMINI_API_KEY && !process.env.DEEPSEEK_API_KEY) { console.error("No GEMINI_API_KEY or DEEPSEEK_API_KEY set: nothing to evaluate."); process.exit(2); }

async function once(s: Scenario): Promise<{ output: string; failed: string[] }> {
  if (s.kind === "tutor") {
    const system = liveInstructions({ subject: s.subject, level: s.level, ib: s.ib });
    const messages = [{ role: "system", content: system }, ...s.history.map((t) => ({ role: t.role, content: t.text }))];
    const res: any = await createTutorChat({ messages, temperature: 0.6, max_tokens: 500 }, true);
    const reply = String(res?.choices?.[0]?.message?.content || "").trim();
    return { output: reply, failed: s.checks.filter((c) => !c.test(reply)).map((c) => c.name) };
  }
  const tokens = { in: 0, out: 0, cachedIn: 0 };
  const out = await writeBoard({ exchange: s.exchange, board: [] }, tokens);
  const lines = out.board.map((e: any) => String(e.text || ""));
  return { output: JSON.stringify({ lines, flags: out.flags }), failed: s.checks.filter((c) => !c.test(lines, out.flags || [])).map((c) => c.name) };
}

let passed = 0, failed = 0;
const rows: { id: string; pass: number; runs: number }[] = [];
for (const s of SCENARIOS) {
  if (only && s.id !== only) continue;
  let pass = 0;
  for (let r = 0; r < runs; r++) {
    try {
      const { output, failed: f } = await once(s);
      if (!f.length) pass++; else console.log(`FAIL  ${s.id}  [${f.join("; ")}]\n      ${output.replace(/\s+/g, " ").slice(0, 220)}`);
    } catch (e: any) { console.log(`ERROR ${s.id}: ${String(e?.message || e).slice(0, 160)}`); }
  }
  rows.push({ id: s.id, pass, runs });
  if (pass === runs) { passed++; console.log(`PASS  ${s.id}${runs > 1 ? ` (${pass}/${runs})` : ""}`); } else failed++;
}
console.log(`\n${passed} scenario(s) passed, ${failed} failed (${runs} run${runs > 1 ? "s" : ""} each). Save this output with the date and model setup when you change prompts, models or providers.`);
process.exit(failed ? 1 : 0);
