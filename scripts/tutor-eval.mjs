// Cheap live check of the tutor: scripted students (maths, a language, a humanities topic) talk to the REAL engine and model, and
// the transcript is printed with automatic flags. ~15 calls on the flash model (a few cents); stops at --max-usd (default 0.15).
//   DEEPSEEK_API_KEY=... npx tsx scripts/tutor-eval.mjs [--max-usd 0.1] [--only maths]
import "../server/env.ts";
import { runTutorTurn } from "../server/tutorTurn/engine.ts";
import { callCostUsd } from "../shared/types.ts";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const maxUsd = Number(arg("max-usd", 0.15)), only = arg("only", "");
if (!process.env.DEEPSEEK_API_KEY) { console.error("Set DEEPSEEK_API_KEY to run the live tutor check."); process.exit(1); }

const SCENARIOS = {
  maths: { subject: "Maths", turns: ["Can you help me solve x^2 - 5x + 6 = 0?", "I think I need to factor it?", "x minus 2 and x minus 3", "so x is 2 or 3", "why does that work?"] },
  language: { subject: "French", turns: ["I want to practise the passé composé", "j'ai mangé une pomme hier", "is it je suis allé or j'ai allé?", "because aller uses être?", "ok give me another one"] },
  history: { subject: "History", turns: ["Why did World War One start?", "the assassination of Franz Ferdinand?", "i don't get why that led to a whole war", "alliances I guess", "ok"] },
};

const words = (t) => t.split(/\s+/).filter(Boolean).length;
let spent = 0, flags = 0;
for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (only && only !== name) continue;
  console.log(`\n=== ${name} ===`);
  let history = [], board = [];
  for (const message of sc.turns) {
    if (spent >= maxUsd) { console.log(`(budget $${maxUsd} reached — stopping)`); break; }
    const r = await runTutorTurn({ message, history, board, problems: [], objectives: [], context: { subject: sc.subject, profile: {} }, lang: "en" });
    spent += callCostUsd(r.tokens.in, r.tokens.out, r.tokens.cachedIn);
    if (r.error) { console.log(`STUDENT: ${message}\n  !! error ${r.errorKind || ""}`); flags++; continue; }
    const f = [];
    if (words(r.reply) > 70) f.push("long (lecture?)");
    if (!/\?\s*$/.test(r.reply.trim())) f.push("does not end on a question");
    if (!r.board.length && /[\d=]|solve|factor|equation/i.test(message + r.reply) && name === "maths") f.push("maths turn wrote nothing on the board");
    if (/on the board/i.test(r.reply) && !r.board.length) f.push("claims the board but wrote nothing");
    flags += f.length;
    console.log(`STUDENT: ${message}\nOTTO: ${r.reply}\n  board: ${r.board.map((e) => String(e.text || e.kind).slice(0, 50)).join(" | ") || "(nothing)"}${f.length ? `\n  FLAGS: ${f.join("; ")}` : ""}`);
    history = [...history, { role: "user", text: message }, { role: "assistant", text: r.reply }];
    board = [...board, ...r.board];
  }
}
console.log(`\nspent ≈ $${spent.toFixed(4)} · flags: ${flags}`);
