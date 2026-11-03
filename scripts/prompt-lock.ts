// The freeze lock: a hash of the pieces of the tutor that are frozen (docs/prompt-freeze.md): the charter, the situation cards and the judge rubric.
//   npm run prompt:lock      write prompt.lock.json from the current text (run it only after the freeze suite passed)
// tests/run.mjs recomputes the hash and fails when the text changed without a new lock (PROMPT_UNLOCK=1 skips the check while editing).
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { CHARTER, renderJudgeRubric } from "../shared/tutorCharter.ts";
import { SITUATION_CARDS } from "../shared/situations.ts";

export function promptFingerprint(): { charter: string; cards: string; rubric: string } {
  const h = (x: string) => createHash("sha256").update(x).digest("hex");
  return {
    charter: h(JSON.stringify(CHARTER)),
    cards: h(JSON.stringify(SITUATION_CARDS.map((c) => ({ id: c.id, text: c.text, cooldown: c.cooldown })))),
    rubric: h(renderJudgeRubric()),
  };
}

if (process.argv[1]?.endsWith("prompt-lock.ts")) {
  const lock = { frozenAt: new Date().toISOString(), ...promptFingerprint() };
  writeFileSync(new URL("../prompt.lock.json", import.meta.url), JSON.stringify(lock, null, 2) + "\n");
  console.log("prompt.lock.json written:", lock);
}
