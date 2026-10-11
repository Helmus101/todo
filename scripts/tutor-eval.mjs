// Live tutor evaluation with simulated students — needs a real model key (GEMINI_API_KEY or DEEPSEEK_API_KEY).
//   npx tsx scripts/tutor-eval.mjs            → runs every persona on the default problem
//   npx tsx scripts/tutor-eval.mjs impatient  → one persona
// Each persona is played by the same model with a short brief; the REAL tutor pipeline (solver + runTutorTurn + guards)
// answers. Transcripts are printed for a human to read: does Otto diagnose, choose the right amount of help, stay
// correct, and leave the student doing the thinking?
import { runTutorTurn } from "../server/tutor.ts";
import { solveProblem } from "../server/solver.ts";
import { createTutorChat } from "../server/claude.ts";

const PROBLEM = process.env.EVAL_PROBLEM || "A 900 kg truck climbs a 12° slope at a constant 10 m/s against 360 N of friction, while accelerating at 0.4 m/s². What power (in W) does the engine deliver?";
const PERSONAS = {
  "wrong-rule": "You confidently use the wrong rule: you think friction should be SUBTRACTED from the driving force, and you only change your mind if the tutor makes you see why.",
  "dont-know": "You answer 'I don't know' or 'no idea' to most questions until the tutor really explains something; then you try.",
  "no-why": "You get numbers right by plugging into formulas but can't explain why when asked.",
  "impatient": "You are impatient and keep asking for the answer ('just tell me'), but you will work if pushed kindly.",
};
const TURNS = Number(process.env.EVAL_TURNS || 8);

async function student(persona, transcript) {
  const res = await createTutorChat({ max_tokens: 300, temperature: 0.8, messages: [
    { role: "system", content: `You are a 16-year-old student being tutored on this problem: ${PROBLEM}\n${persona}\nReply as the student in one or two short sentences. Never act as the tutor.` },
    ...transcript.map((m) => ({ role: m.role === "user" ? "assistant" : "user", content: m.text })),
  ] }, true);
  return String(res?.choices?.[0]?.message?.content || "").trim();
}

const which = process.argv[2];
const { solution } = await solveProblem(PROBLEM, "Physics");
console.log(`\n=== solution (${solution?.verified ? "verified" : "UNVERIFIED"}): ${solution?.finalAnswer}`);
for (const [name, persona] of Object.entries(PERSONAS)) {
  if (which && which !== name) continue;
  console.log(`\n\n######## ${name} ########`);
  const history = [];
  let board = [], teaching;
  let message = PROBLEM;
  for (let i = 0; i < TURNS; i++) {
    const out = await runTutorTurn({ history, message, board, problems: [], objectives: [], context: {}, lang: "en", solution, teaching });
    console.log(`\nSTUDENT: ${message}\nOTTO${out.plan ? ` [${out.plan.action}/${out.plan.helpLevel}]` : ""}: ${out.reply}${out.board.length ? `\n  board+ ${out.board.map((b) => b.text).join(" | ")}` : ""}`);
    history.push({ role: "user", text: message }, { role: "assistant", text: out.reply });
    board = out.boardCleared ? out.board : [...board, ...out.board];
    message = await student(persona, history);
  }
}
