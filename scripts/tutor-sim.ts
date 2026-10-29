// Simulated IB students against the REAL tutor prompt, the REAL board writer and a judge, with no script: a model plays a confused student
// (garbled speech, wrong methods, impatience, "put it on the board") and answers whatever the tutor actually says. Each exchange runs the
// same two board passes the app runs (one while the tutor is still speaking, one after), then a judge reads the exchange and the board and
// reports mistakes. A fixed list of facts is also checked in code (a board line whose arithmetic fails).
//   npm run sim:tutor                        every persona, 12 turns each
//   npm run sim:tutor -- --persona logs-confused --turns 16
//   npm run sim:tutor -- --runs 2            repeat each persona (models vary run to run)
// Needs GEMINI_API_KEY and/or DEEPSEEK_API_KEY in .env and costs a few cents per persona. The tutor here is the typed tutor model standing in
// for the live voice model; it follows the same prompt but is not identical, so treat results as strong evidence, not proof.
import "../server/env.ts";
import { createTutorChat } from "../server/claude.ts";
import { liveInstructions, exchangeText } from "../shared/liveTutor.ts";
import { writeBoard, splitOpenQuestion, posesProblem, problemOnBoard, promisesBoard } from "../server/tutorTurn/boardWriter.ts";
import { boardLineIsWrong } from "../server/boardMath.ts";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const onlyPersona = arg("--persona");
const turnsN = Math.max(4, Number(arg("--turns")) || 12);
const runs = Math.max(1, Number(arg("--runs")) || 1);
const verbose = process.argv.includes("--verbose");

interface Persona { id: string; subject: string; level: string; who: string; opener: string }

const PERSONAS: Persona[] = [
  { id: "logs-confused", subject: "Math AA HL", level: "IB DP2", opener: "let's work on some log questions",
    who: "You are a Math AA HL student who half understands logarithms. You mix up when to add and multiply, forget to check the domain, and sometimes say a step out loud wrongly and then correct yourself. Your speech comes from a microphone: lowercase, fillers (um, uh, so), sometimes a word is mis-heard. Ask 'wait, which one is it?' or 'did you put it on the board?' when you cannot see the problem on the board." },
  { id: "log-law-misconception", subject: "Math AA SL", level: "IB DP1", opener: "I need help with logs, I think log of a plus b is log a plus log b",
    who: "You are a Math AA SL student who firmly believes log(a+b) = log a + log b and the equivalent mistakes (ln(x+1) derivative is 1/x). You defend it until shown a numerical counterexample you work out yourself. You speak in short spoken sentences." },
  { id: "impatient-hl", subject: "Math AA HL", level: "IB DP2", opener: "just tell me how to integrate x e to the x",
    who: "You are a stressed Math AA HL student with a test tomorrow. You want the answer fast, say 'just tell me', 'I don't have time', but when the tutor gives a small question you do answer it, sometimes wrongly (sign errors, forgetting the plus C, dropping a term in integration by parts). Speak briefly." },
  { id: "one-word-guesser", subject: "Math AI SL", level: "IB DP1", opener: "statistics",
    who: "You are a quiet Math AI SL student. You answer in one to four words, often guess ('maybe 5?', 'mean?', 'idk'), and rarely volunteer reasoning unless asked twice. Topic you struggle with: standard deviation, normal distribution, and when to use which calculator function." },
  { id: "physics-units-mixer", subject: "Physics HL", level: "IB DP2", opener: "can we do projectile motion",
    who: "You are a Physics HL student who mixes up horizontal and vertical components, forgets g is negative, uses degrees vs radians wrongly, and drops units. You say numbers aloud as words ('twenty metres per second'). When shown a problem you say what you would do first, often wrongly." },
  { id: "chem-moles-lost", subject: "Chemistry SL", level: "IB DP1", opener: "I don't get moles at all",
    who: "You are a Chemistry SL student lost on moles, molar mass, limiting reagents and concentration. You confuse grams with moles, forget to balance equations first, and are shy about asking. You speak in short, uncertain sentences." },
  { id: "asr-heavy", subject: "Math AA HL", level: "IB DP2", opener: "frisch lets do derivatives",
    who: "You are a Math AA HL student whose speech recognition is bad: about one word in six is mis-transcribed (similar sounding words, numbers as words, 'x squared' written 'x score', 'sine' as 'sign'). Your maths is decent but you sometimes state a step wrong. The tutor must work out what you meant without you repeating perfectly; if it guesses wrong you say 'no, I said ...'." },
  { id: "board-watcher", subject: "Math AA HL", level: "IB DP2", opener: "give me a hard question on vectors",
    who: "You are a Math AA HL student who looks at the board constantly. Whenever the tutor poses a problem you check the BOARD shown to you; if the problem is NOT on the board you say so ('I can't see it on the board', 'can you write it down?'). If it is there, you start and work through it, making a mistake of your own in the middle (for example a sign slip in a scalar product) and sometimes asking 'is that right?'." },
  { id: "drifter", subject: "Economics SL", level: "IB DP1", opener: "so I have an economics test on elasticity",
    who: "You are an Economics SL student who drifts: you mention your weekend, a game, how tired you are, then come back to elasticity. You confuse PED with the gradient of the demand curve and mix up elastic and inelastic. Speak casually." },
  { id: "show-that-shortcut", subject: "Math AA HL", level: "IB DP2", opener: "I have a show that question about derivatives",
    who: "You are a Math AA HL student working on a 'show that' question. You try to start from the answer and work backwards, skip algebra lines, and assume the tutor will accept it. You get frustrated when told to show every step but then do it. Speak in short spoken sentences." },
];

type Turn = { who: "student" | "tutor"; text: string };

async function chat(messages: any[], opts: { temperature?: number; max_tokens?: number; json?: boolean } = {}): Promise<string> {
  const res: any = await createTutorChat({ messages, temperature: opts.temperature ?? 0.7, max_tokens: opts.max_tokens ?? 500, ...(opts.json ? { response_format: { type: "json_object" } } : {}) }, true);
  return String(res?.choices?.[0]?.message?.content || "").trim();
}

const boardText = (board: any[]): string => board.length ? board.map((e, i) => `${i + 1}. [${e.kind}] ${String(e.text || "").replace(/\s+/g, " ")}`).join("\n") : "(the board is empty)";

function mergeById(existing: any[], incoming: any[]): any[] {
  const seen = new Set(existing.map((x) => x.id));
  const fresh = incoming.filter((x) => x && !seen.has(x.id));
  return fresh.length ? [...existing, ...fresh] : existing;
}

async function studentSays(p: Persona, history: Turn[], board: any[]): Promise<string> {
  const sys = `${p.who}\nYou are talking to a voice tutor and can see a shared board. Reply ONLY with what you say out loud next (one to three short sentences, as a speech-to-text transcript would show it). Never mention being simulated or an AI. React to what the tutor just said: answer its question, ask for what you need, or push back. Stay in character, stay a believable IB student, and do not solve things perfectly.\n\nWHAT YOU CAN SEE ON THE BOARD RIGHT NOW:\n${boardText(board)}`;
  const msgs = [{ role: "system", content: sys }, ...history.map((t) => ({ role: t.who === "student" ? "assistant" : "user", content: t.text })), ...(history.length ? [] : [{ role: "user", content: "(The tutor greets you.)" }])];
  const out = await chat(msgs, { temperature: 0.9, max_tokens: 120 });
  return out.replace(/^["“]|["”]$/g, "").trim() || "um";
}

const JUDGE_SYS = `You are a strict, fair reviewer of ONE exchange in an IB maths/science tutoring session. You are given the subject, the recent conversation, the board BEFORE and AFTER this exchange, and the tutor's latest reply. The student is speaking through speech recognition, so garbled wording is normal and the tutor may reasonably interpret it, but it must not confirm something false.
Check the tutor's latest reply and the board strictly against correct mathematics/science. Return ONLY JSON:
{"tutor_errors":["a false mathematical or scientific statement the tutor made, quoted"],
 "confirmed_wrong_step":"quote the student step the tutor confirmed (yes/right/exactly/spot on) although it is wrong, or empty",
 "retracted_correct_step":"quote what the tutor doubted or took back although the student had it right, or empty",
 "claims_on_board_but_absent":"quote where the tutor says it is on the board / wrote it / put it up, but the board AFTER does not contain it, or empty",
 "problem_missing_from_board":"if the tutor posed a concrete problem or equation to work on in this reply and the board AFTER does not show it, write the problem, else empty",
 "student_step_missing":"if the tutor confirmed a correct student step this reply and the board AFTER does not show that step, write it, else empty",
 "board_errors":["a board line (after) that is mathematically wrong, garbled, or says something the student/tutor did not say"],
 "answer_on_board_too_early":"a board line that already contains the answer to the question the tutor just asked and the student has not yet answered, or empty",
 "handed_over_answer":"quote if the tutor stated the final answer to a problem the student is still solving (hints are fine), or empty",
 "ignored_request":"if the student asked for something (repeat, write it on the board, explain, which problem) and the tutor did not do it, say what, else empty"}
Be conservative: only flag what you are sure about. Empty string or empty list means no problem.`;

interface Flags { [k: string]: any }
async function judge(p: Persona, history: Turn[], before: any[], after: any[]): Promise<Flags> {
  const convo = history.slice(-6).map((t) => `${t.who === "student" ? "Student" : "Tutor"}: ${t.text}`).join("\n");
  const user = `Subject: ${p.subject}\n\nRECENT CONVERSATION (the last line is the tutor's latest reply):\n${convo}\n\nBOARD BEFORE:\n${boardText(before)}\n\nBOARD AFTER:\n${boardText(after)}`;
  try {
    const raw = await chat([{ role: "system", content: JUDGE_SYS }, { role: "user", content: user }], { temperature: 0, max_tokens: 700, json: true });
    return JSON.parse(raw.replace(/^```(?:json)?|```$/g, ""));
  } catch { return { judge_failed: true }; }
}

const cut = (s: string, n = 160) => s.replace(/\s+/g, " ").slice(0, n);

async function runPersona(p: Persona): Promise<{ flags: { turn: number; kind: string; text: string }[]; turns: number }> {
  const history: Turn[] = [];
  let board: any[] = [];
  const flags: { turn: number; kind: string; text: string }[] = [];
  const system = liveInstructions({ subject: p.subject, level: p.level, ib: true });
  const tutorMsgs = (extra: Turn[]) => [{ role: "system", content: system }, { role: "user", content: "(Session started. Greet me briefly.)" }, ...extra.map((t) => ({ role: t.who === "student" ? "user" : "assistant", content: t.text }))];
  const tokens = { in: 0, out: 0, cachedIn: 0 };
  console.log(`\n=== ${p.id} (${p.subject}) ===`);
  // The tutor greets first, as in the app.
  const greet = await chat(tutorMsgs([]), { temperature: 0.6 });
  history.push({ who: "tutor", text: greet });
  console.log(`Tutor: ${greet}`);
  let student = p.opener;
  for (let turn = 1; turn <= turnsN; turn++) {
    history.push({ who: "student", text: student });
    console.log(`\nStudent: ${student}`);
    const reply = await chat(tutorMsgs(history), { temperature: 0.6 });
    history.push({ who: "tutor", text: reply });
    console.log(`Tutor: ${reply}`);
    const before = board;
    const chatLines = history.slice(-14, -2).map((t) => ({ who: t.who === "student" ? "you" as const : "otto" as const, text: t.text.slice(0, 400) }));
    const lean = board.slice(-16);
    const turnsNow = [{ who: "you" as const, text: student }, { who: "otto" as const, text: reply }];
    // Pass 1, while the tutor is still speaking: the whole sentences said so far (as the app does once enough has been said).
    const sentences = reply.split(/(?<=[.?!])\s+/).map((x) => x + " ");
    let partial = "";
    for (const s of sentences) { partial += s; if (partial.length >= 90 && partial.split(/\s+/).length >= 16 && partial.trim().length < reply.trim().length - 20) break; }
    if (partial && partial.trim().length < reply.trim().length - 20) {
      try {
        const early = await writeBoard({ exchange: exchangeText([{ who: "you", text: student }, { who: "otto", text: partial.trim() }]), board: lean, subject: p.subject, history: exchangeText(chatLines), early: true }, tokens);
        board = mergeById(board, early.board);
      } catch (e: any) { console.log(`   (early board pass failed: ${cut(String(e?.message || e), 80)})`); }
    }
    // Pass 2, after the turn.
    try {
      const out = await writeBoard({ exchange: exchangeText(turnsNow), board: board.slice(-16), subject: p.subject, history: exchangeText(chatLines) }, tokens);
      board = mergeById(board, out.board);
      for (const f of out.flags || []) flags.push({ turn, kind: "second-opinion flag", text: f });
    } catch (e: any) { flags.push({ turn, kind: "board pass failed", text: cut(String(e?.message || e), 100) }); }
    const added = board.slice(before.length);
    for (const e of added) console.log(`   board + [${e.kind}] ${cut(String(e.text || ""), 120)}`);
    if (!added.length) console.log("   board: (nothing written)");
    // Code checks: a board line whose own arithmetic fails.
    for (const e of added) if (typeof e.text === "string" && boardLineIsWrong(e.text)) flags.push({ turn, kind: "board line arithmetic wrong", text: cut(e.text) });
    // Code checks the judge cannot be trusted with: a problem the tutor poses must be on the board, and "it is on the board" must be true.
    const open = splitOpenQuestion(`Tutor: ${reply}`).openQuestion;
    if (open && posesProblem(open) && !problemOnBoard(open, board)) flags.push({ turn, kind: "CODE: posed problem not on the board", text: cut(open, 200) });
    if (promisesBoard(reply) && !added.length && !/\b(?:not|isn't|is not|can't|cannot)\b[^.?!]{0,20}\bboard\b/i.test(reply) && !problemOnBoard(open || reply, board)) flags.push({ turn, kind: "CODE: says it is on the board, nothing was written", text: cut(reply, 200) });
    // The judge.
    const j = await judge(p, history, before, board);
    const add = (kind: string, v: any) => { const t = Array.isArray(v) ? v.filter(Boolean).join(" | ") : String(v || ""); if (t.trim()) flags.push({ turn, kind, text: cut(t, 240) }); };
    add("tutor math/science error", j.tutor_errors); add("confirmed a wrong step", j.confirmed_wrong_step); add("took back a correct step", j.retracted_correct_step);
    add("says it is on the board but it is not", j.claims_on_board_but_absent); add("posed problem not on board", j.problem_missing_from_board); add("confirmed step not on board", j.student_step_missing);
    add("board line wrong", j.board_errors); add("answer on board too early", j.answer_on_board_too_early); add("handed over the answer", j.handed_over_answer); add("ignored a request", j.ignored_request);
    if (j.judge_failed) console.log("   (judge failed this turn)");
    for (const f of flags.filter((x) => x.turn === turn)) console.log(`   !! ${f.kind}: ${f.text}`);
    if (turn < turnsN) student = await studentSays(p, history, board);
  }
  console.log(`\nBOARD AT THE END:\n${boardText(board)}`);
  return { flags, turns: turnsN };
}

const picked = PERSONAS.filter((p) => !onlyPersona || p.id === onlyPersona);
if (!picked.length) { console.error(`No persona '${onlyPersona}'. Choose from: ${PERSONAS.map((p) => p.id).join(", ")}`); process.exit(2); }
if (!process.env.GEMINI_API_KEY && !process.env.DEEPSEEK_API_KEY) { console.error("No GEMINI_API_KEY or DEEPSEEK_API_KEY set."); process.exit(2); }

const summary: Record<string, number> = {};
let total = 0;
const perPersona: { id: string; n: number }[] = [];
for (const p of picked) {
  for (let r = 0; r < runs; r++) {
    try {
      const out = await runPersona(p);
      perPersona.push({ id: p.id, n: out.flags.length });
      for (const f of out.flags) { summary[f.kind] = (summary[f.kind] || 0) + 1; total++; }
      if (verbose) console.log(JSON.stringify(out.flags, null, 1));
    } catch (e: any) { console.log(`ERROR ${p.id}: ${String(e?.message || e).slice(0, 200)}`); }
  }
}
console.log(`\n===== SUMMARY: ${total} flag(s) across ${perPersona.length} run(s) of ${turnsN} turns =====`);
for (const [k, v] of Object.entries(summary).sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(3)}  ${k}`);
for (const r of perPersona) console.log(`${String(r.n).padStart(3)} flag(s)  ${r.id}`);
console.log("\nThe judge is a model: read the flagged lines in the transcript before acting on a flag. A flag is a lead, not a verdict.");
