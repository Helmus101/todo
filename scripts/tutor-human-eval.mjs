// Transcript check for how human the typed tutor sounds: scripted students with moods, fillers, pushback and small talk, real engine and model.
//   (from the repo root)  npx tsx scripts/tutor-human-eval.mjs [--only physics|logs|chain] [--max-usd 0.3]
const root = process.cwd();
await import(`${root}/server/env.ts`);
const { runTutorTurn } = await import(`${root}/server/tutorTurn/engine.ts`);
const { callCostUsd } = await import(`${root}/shared/types.ts`);

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const maxUsd = Number(arg("max-usd", 0.3)), only = arg("only", "");

const SCENARIOS = {
  physics: { subject: "Physics", turns: [
    "ugh i have a physics test tomorrow and i still dont get why a ball thrown straight up has zero velocity at the top but is still accelerating",
    "ok",
    "wait so the acceleration is never zero? even at the very top",
    "ohhh ok that actually makes sense",
    "can u give me one quick practice q on this",
  ] },
  logs: { subject: "Maths", turns: [
    "Solve log_2(x) + log_2(x-2) = 3. I got x = 4 and x = -2",
    "idk",
    "just tell me pls i have 10 more of these",
    "are you sure? my friend said both work",
    "thanks ur better than my teacher lol",
  ] },
  chain: { subject: "Maths", turns: [
    "hi",
    "im so tired honestly",
    "can we do the chain rule. like d/dx of (x^2+1)^3",
    "um",
    "so its 6x(x^2+1)^2 ?",
    "why do you multiply by the 2x though",
  ] },
};

const words = (t) => t.split(/\s+/).filter(Boolean).length;
let spent = 0;
for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (only && only !== name) continue;
  console.log(`\n=== ${name} ===`);
  let history = [], board = [];
  for (const message of sc.turns) {
    if (spent >= maxUsd) { console.log(`(budget reached)`); break; }
    const r = await runTutorTurn({ message, history, board, problems: [], objectives: [], context: { subject: sc.subject, profile: {} }, lang: "en" });
    spent += callCostUsd(r.tokens.in, r.tokens.out, r.tokens.cachedIn);
    if (r.error) { console.log(`STUDENT: ${message}\n  !! error ${r.errorKind || ""}`); continue; }
    console.log(`STUDENT: ${message}\nOTTO (${words(r.reply)}w, ${r.turn?.ms}ms): ${r.reply}\n  board: ${r.board.map((e) => String(e.text || e.kind).slice(0, 70)).join(" | ") || "(nothing)"}`);
    history = [...history, { role: "user", text: message }, { role: "assistant", text: r.reply }];
    board = [...board, ...r.board];
  }
}
console.log(`\nspent ≈ $${spent.toFixed(4)}`);
