// Re-score the transcripts of an earlier run (e.g. after a judge failure) and rewrite its scorecard.
//   npx tsx scripts/tutor-eval/rejudge.mjs <run-dir> [--all]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spend, provider } from "./lib.mjs";
import { judge } from "./judge.mjs";
import { byId } from "./scenarios.mjs";
import { writeScorecard } from "./scorecard.mjs";
const dir = process.argv[2], all = process.argv.includes("--all");
const results = readFileSync(join(dir, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
for (const r of results) {
  if (!r.metrics || (!all && r.judge && !r.judge.error && r.judge.mean)) continue;
  r.judge = await judge(null, byId[r.id], r.transcript);
  console.log(r.id, r.judge.mean, r.judge.error || "");
}
writeFileSync(join(dir, "results.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeScorecard({ results, chosen: results, stopped: false, tag: dir.split("/").pop(), OUT: dir, noJudge: false, spend, provider: provider() });
