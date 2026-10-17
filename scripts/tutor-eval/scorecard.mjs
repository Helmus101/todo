// The scorecard written after a run (and after a re-judge).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIMS } from "./judge.mjs";

export function writeScorecard({ results, chosen, stopped, tag, OUT, noJudge, spend, provider }) {
  const ok = results.filter((r) => r.metrics);
  const avg = (f) => (ok.length ? ok.reduce((n, r) => n + f(r), 0) / ok.length : 0);
  let md = `# Tutor evaluation ${tag}\n\nprovider: ${provider} · scenarios run: ${ok.length}/${chosen.length}${stopped ? " (STOPPED: budget reached)" : ""} · spend: $${spend.usd.toFixed(3)} (${spend.calls} calls, ${spend.inTok} in / ${spend.outTok} out tokens)\n\n`;
  const hardLines = ok.flatMap((r) => [...r.metrics.flags.filter((f) => ["tool-syntax", "leak", "wrong-arithmetic", "board-claim"].includes(f.kind)).map((f) => `- **${r.id}** turn ${f.turn}: ${f.kind} — ${f.detail}`), ...(r.metrics.errors ? [`- **${r.id}**: ${r.metrics.errors} tutor error turn(s)`] : []), ...(r.judge?.hard_fail ? [`- **${r.id}** (judge): ${r.judge.hard_fail_reason}`] : [])]);
  md += `## Hard fails (${hardLines.length})\n${hardLines.join("\n") || "none"}\n\n`;
  md += `## Judge means (1-5)\n| scenario | ${DIMS.join(" | ")} | mean |\n|---|${DIMS.map(() => "---").join("|")}|---|\n`;
  for (const r of ok) md += `| ${r.id} | ${r.judge?.scores ? DIMS.map((d) => r.judge.scores[d] ?? "-").join(" | ") : DIMS.map(() => "-").join(" | ")} | ${r.judge?.mean ?? "-"} |\n`;
  if (!noJudge) md += `| **average** | ${DIMS.map((d) => (avg((r) => r.judge?.scores?.[d] || 0)).toFixed(2)).join(" | ")} | ${avg((r) => r.judge?.mean || 0).toFixed(2)} |\n`;
  md += `\n## Soft metrics\n| scenario | words avg/max | multi-Q | repeats | name-starts | why-ignored/asked | q-only run | repaired | dropped | ms med/p90 | problems solved | kinds | repeated openers | stock phrases |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of ok) { const m = r.metrics; md += `| ${r.id} | ${m.wordsAvg}/${m.wordsMax} | ${m.multiQuestionReplies} | ${m.repeats} | ${m.nameStarts} | ${m.askedWhyIgnored}/${m.askedWhy} | ${m.questionMoveRunMax} | ${m.repaired} | ${m.droppedOps} | ${m.msMedian}/${m.msP90} | ${m.solved}/${m.problems} | ${m.problemKinds.join(",") || "-"} | ${(m.repeatedOpeners || []).join("; ") || "-"} | ${m.stockPhrases ?? "-"} |\n`; }
  md += `\n## Judge: what to fix first, per scenario\n`;
  for (const r of ok) if (r.judge?.summary) md += `- **${r.id}** (${r.judge.mean}): ${r.judge.summary}${(r.judge.worst_turns || []).map((w) => `\n  - turn ${w.turn}: ${w.why}`).join("")}\n`;
  const flagCounts = {}; for (const r of ok) for (const f of r.metrics.flags) flagCounts[f.kind] = (flagCounts[f.kind] || 0) + 1;
  md += `\n## Flag totals\n${Object.entries(flagCounts).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "none"}\n`;
  const issues = {}; for (const r of ok) for (const [k, v] of Object.entries(r.metrics.issueCounts)) issues[k] = (issues[k] || 0) + v;
  md += `\n## Verifier issues raised by the engine (first pass, before repair)\n${Object.entries(issues).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "none"}\n`;
  writeFileSync(join(OUT, "scorecard.md"), md);
    console.log(`\n${md.split("\n").slice(0, 3).join("\n")}\nscorecard: ${join(OUT, "scorecard.md")}`);

}
