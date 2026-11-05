// Replays a real student's lines, verbatim, through the REAL typed tutor engine (charter prompt, gate, board) and prints what Otto says.
//   npx tsx scripts/replay-session.ts arccos          (lines of the Math AA HL arccos session, noise included)
import "../server/env.ts";
import { runTutorTurn } from "../server/tutorTurn/engine.ts";
import { stockPraiseOpener } from "../server/tutorTurn/spokenCheck.ts";

const SESSIONS: Record<string, { subject: string; lines: string[] }> = {
  arccos: { subject: "Math AA HL", lines: [
    "arccos x plus arccos root 3 x equals 3 pi over 2 and we need to find x given it's between minus 1 over root 3 and 1 over root 3",
    "minus power to the power to", "Aga", "Pai.", "Well, the sum is valid because it's smaller than 2 pi.", "ahora o viceversa",
    "two values that are smaller than well, they must add to 3 pi over 2.", "Ahora no.", "I don't know. Let's just solve the equation like, right?",
    "I would take the cosine of each side.", "So basically you have cosine arc cosine x times cosine arc cosine root 3 x minus sin arc cosine x times sin arc cosine root 3 x.",
    "square root of 1 minus x squared", "square root of 1 minus 3x squared", "Maybe bring the one to the other side and then after you just solve. And then you square everything, right?",
    "so 3x to the fourth equals 3x to the fourth minus 4x squared plus 1", "We've been over the whole question.", "minus 4x squared plus 1 equals 0, so x squared is a quarter, so x is plus or minus a half." ] },
  rational: { subject: "Math AA HL", lines: [
    "the graph of f has vertical asymptote x equals 0.25, horizontal asymptote y equals 0.5 and crosses the x axis at 5, 0. Find f of x in the form ax plus b over cx plus d where all of them are integers.",
    "Was it a equals 0.5 c?", "d equals minus 0.25 c", "What do you mean?", "So c equals 4, then a equals 2 and d equals minus 1.", "What do you mean?",
    "Wait, how did we pick c equals 4? Isn't it just random?", "So we have 2x plus b over 4x minus 1, right? And now let's plug in x equals 0." ] },
};
const name = process.argv[2] || "arccos";
const s = SESSIONS[name];
if (!s) { console.error(`Choose: ${Object.keys(SESSIONS).join(", ")}`); process.exit(2); }
let history: { role: "user" | "assistant"; text: string }[] = [];
let board: any[] = [];
let praise = 0;
const FROM = Number(process.argv[3]) || 0;
for (const [i, line] of s.lines.entries()) {
  if (i < FROM) { history = [...history, { role: "user", text: line }, { role: "assistant", text: "(skipped)" }]; continue; }
  await new Promise((r) => setTimeout(r, 5000)); // stay under the provider rate limits
  console.log(`\nStudent: ${line}`);
  let r: any = null;
  for (let attempt = 0; attempt < 3; attempt++) { r = await runTutorTurn({ message: line, history, board, problems: [], objectives: [], context: { subject: s.subject } as any, lang: "en", voiceMode: true } as any); if (!r.error) break; console.log(`   (retry ${attempt + 1}: ${r.errorKind || "error"})`); }
  if (r.error) { console.log(`   (engine error: ${r.errorKind || "unknown"})`); break; }
  console.log(`Otto: ${r.reply}`);
  const p = stockPraiseOpener(r.reply); if (p) { praise++; console.log(`   !! stock praise: ${p}`); }
  for (const e of r.board) console.log(`   board + [${e.kind}] ${String(e.text || "").slice(0, 110)}`);
  board = [...board, ...r.board];
  history = [...history, { role: "user", text: line }, { role: "assistant", text: r.reply }];
}
console.log(`\nstock-praise openers: ${praise}`);
