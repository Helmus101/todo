// Run scenarios against the REAL tutor with a model-played student, score them, write a scorecard.
//   npx tsx scripts/tutor-eval/run.mjs [ids|all] [--no-judge] [--tag name]
//   EVAL_OUT=<dir>  EVAL_PAR=3  EVAL_BUDGET=15 (USD, stops starting new scenarios past it)  EVAL_TURNS=<n overrides every scenario>
// Live model calls cost money; the spend is tracked with the app's own rates and printed.
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { newSession, playTurn, widgetAnswer, createTutorChat, usageOf, addSpend, spend, provider } from "./lib.mjs";
import { SCENARIOS, byId } from "./scenarios.mjs";
import { computeMetrics } from "./metrics.mjs";
import { judge, DIMS } from "./judge.mjs";

const args = process.argv.slice(2);
const noJudge = args.includes("--no-judge");
const tagAt = args.indexOf("--tag");
const tag = tagAt >= 0 ? args[tagAt + 1] : new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const ids = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--tag");
const chosen = !ids.length || ids[0] === "all" ? SCENARIOS : ids.flatMap((x) => x.split(",")).map((x) => byId[x] || SCENARIOS.filter((s) => s.id.startsWith(x))).flat().filter(Boolean);
const OUT = join(process.env.EVAL_OUT || "/tmp/tutor-eval", tag);
mkdirSync(OUT, { recursive: true });
const BUDGET = Number(process.env.EVAL_BUDGET || 15), PAR = Number(process.env.EVAL_PAR || 3);

async function studentSay(scenario, S) {
  const open = [...S.problems].reverse().find((p) => !p.solved);
  const ctx = open ? `\n\n[On your screen, in the exercise box under the tutor's message, you can read exactly this: """${open.question}"""${open.options?.length ? ` with options ${open.options.map((o, i) => `(${String.fromCharCode(65 + i)}) ${o}`).join("  ")}` : ""}. You may answer it in the answer box by writing "ANSWER: <the option letter and text, or your value>" — once. If you already answered it, or you'd rather talk, just chat; don't resubmit.]` : "";
  const msgs = S.history.slice(-14).map((m) => ({ role: m.role === "user" ? "assistant" : "user", content: m.text }));
  if (msgs.length && ctx) msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: msgs[msgs.length - 1].content + ctx };
  const res = await createTutorChat({ max_tokens: 200, temperature: 0.85, messages: [{ role: "system", content: `${scenario.persona}\nReply as the student now (the tutor's last message is the last one).` }, ...msgs] }, true);
  addSpend(usageOf(res));
  return String(res?.choices?.[0]?.message?.content || "").trim().replace(/^["“]|["”]$/g, "") || "idk";
}

async function runScenario(scenario) {
  const S = newSession({ subject: undefined, lang: scenario.lang, profile: { name: "Alex", ...scenario.profile }, memory: scenario.memory, dueRetestSkills: scenario.dueRetestSkills || [] });
  S.task.sourceSubject = undefined;
  const turns = Number(process.env.EVAL_TURNS || scenario.turns || 10);
  let message = scenario.opening;
  for (let i = 0; i < turns; i++) {
    let out = await playTurn(S, message, { voice: !!scenario.voice });
    // A provider timeout is infrastructure, not the tutor: retry the turn once before counting it.
    if (out.error) { S.turns.pop(); out = await playTurn(S, message, { voice: !!scenario.voice }); }
    if (out.error) break;
    let said = await studentSay(scenario, S);
    const m = /(?:^|\n)\s*ANSWER\s*:\s*([^\n]+)/i.exec(said);
    if (m && [...S.problems].some((p) => !p.solved)) { const w = widgetAnswer(S, m[1].trim()); message = w ? w.message : m[1].trim(); }
    else message = m ? m[1].trim() : said;
  }
  const metrics = computeMetrics(S, scenario);
  const verdict = noJudge ? null : await judge(S, scenario);
  const rec = { id: scenario.id, subject: scenario.subject, metrics, judge: verdict, transcript: S.turns.map((t) => ({ student: t.message, tutor: t.reply, move: t.turn?.move, support: t.turn?.support, diagnosis: t.turn?.diagnosis, misconception: t.turn?.misconception, angle: t.turn?.angle, ms: t.ms, board: (t.newBoard || []).map((e) => `${e.kind}${e.owner === "student" ? "/student" : ""}: ${String(e.text || "").slice(0, 200)}`), exercises: (t.newProblems || []).map((p) => p.question + (p.options?.length ? `  [options: ${p.options.join(" / ")}]` : "")), issues: t.turn?.issues, dropped: t.turn?.dropped, verdict: t.verdict, error: t.error })) };
  appendFileSync(join(OUT, "results.jsonl"), JSON.stringify(rec) + "\n");
  return rec;
}

const results = [];
let next = 0, stopped = false;
async function worker() {
  while (next < chosen.length) {
    if (spend.usd >= BUDGET) { stopped = true; return; }
    const sc = chosen[next++];
    const t0 = Date.now();
    try { const r = await runScenario(sc); results.push(r); console.log(`${r.id.padEnd(26)} turns ${String(r.metrics.turns).padStart(2)}  hard ${r.metrics.hardFails}  judge ${r.judge ? r.judge.mean : "-"}${r.judge?.hard_fail ? " HARDFAIL" : ""}  ${Math.round((Date.now() - t0) / 1000)}s  $${spend.usd.toFixed(3)}`); }
    catch (e) { console.log(`${sc.id} CRASHED: ${e?.stack || e}`); results.push({ id: sc.id, crashed: String(e?.message || e) }); }
  }
}
console.log(`provider: ${provider()} · scenarios: ${chosen.length} · budget $${BUDGET} · out: ${OUT}`);
await Promise.all(Array.from({ length: PAR }, worker));

import { writeScorecard } from "./scorecard.mjs";
writeScorecard({ results, chosen, stopped, tag, OUT, noJudge, spend, provider: provider() });
