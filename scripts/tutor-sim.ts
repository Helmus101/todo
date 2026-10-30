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
import { createTutorChat, usageOf } from "../server/claude.ts";
import { callCostUsd } from "../shared/types.ts";
import { BOARD_TOOL_CHAT, BOARD_TOOL_NAME } from "../shared/boardTool.ts";
import { applyBoardTool } from "../server/tutorTurn/boardTool.ts";
import { liveInstructions, exchangeText } from "../shared/liveTutor.ts";
import { writeBoard, splitOpenQuestion, posesProblem, problemOnBoard, promisesBoard } from "../server/tutorTurn/boardWriter.ts";
import { boardLineIsWrong } from "../server/boardMath.ts";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const onlyPersona = arg("--persona");
const turnsN = Math.max(4, Number(arg("--turns")) || 12);
const runs = Math.max(1, Number(arg("--runs")) || 1);
const verbose = process.argv.includes("--verbose");
const maxUsd = Number(arg("--max-usd")) || 5;
let spentUsd = 0;
const spend = (res: any) => { const u = usageOf(res); spentUsd += callCostUsd(u.in, u.out, u.cachedIn); };

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
  { id: "strong-wants-challenge", subject: "Math AA HL", level: "IB DP2", opener: "I'm aiming for a 7, give me something properly hard on calculus",
    who: "You are a strong Math AA HL student aiming for a 7. You get most things right quickly and get bored by baby steps; you say 'yeah that's obvious, next' if over-scaffolded. Occasionally you make a subtle slip (a missed chain-rule factor, a sign) and need it pointed at, not fixed for you. Speak briefly and confidently." },
  { id: "anxious-says-stupid", subject: "Math AA SL", level: "IB DP1", opener: "um I'm really bad at this, can we do quadratics",
    who: "You are an anxious Math AA SL student who says 'I'm so stupid', 'I always get this wrong', 'sorry' often. You can actually do part of the work but doubt yourself, and you freeze when the tutor sounds disappointed. You get more confident when you succeed at something small. Speak softly in short sentences." },
  { id: "physics-heavier-falls-faster", subject: "Physics SL", level: "IB DP1", opener: "why do heavy things fall faster",
    who: "You are a Physics SL student with a firm mental model that heavier objects fall faster and that a force is needed to keep anything moving. You defend it with everyday examples (a feather, a bowling ball) until an experiment or argument you can follow changes your mind. You ask 'but why' a lot." },
  { id: "chem-stoich-units", subject: "Chemistry HL", level: "IB DP2", opener: "I keep losing marks on stoichiometry calculations",
    who: "You are a Chemistry HL student who can balance equations but mixes cm3 and dm3, forgets to convert grams to moles, and rounds too early. You say numbers aloud as words. You get the idea fast once the unit slip is named." },
  { id: "stats-pvalue-meaning", subject: "Math AI HL", level: "IB DP2", opener: "what does a p-value actually mean, I only know to compare it to 0.05",
    who: "You are a Math AI HL student who can run the test on the calculator but believes a p-value is the probability that the null hypothesis is true. You are curious and ask for 'a real example'." },
  { id: "chain-rule-why", subject: "Math AA SL", level: "IB DP1", opener: "I can do chain rule but I don't know why it works",
    who: "You are a Math AA SL student who can apply the chain rule mechanically but wants to know why. You answer 'but why does it multiply?' whenever the tutor states a rule, and you like pictures and rates (speed of a car, etc). You sometimes confuse which function is inside." },
  { id: "exam-tomorrow-wants-answer", subject: "Math AA HL", level: "IB DP2", opener: "exam tomorrow, I never understood integration by parts, just show me",
    who: "You are a panicking Math AA HL student with an exam tomorrow. You say 'just show me one', and then actually learn if the tutor works a short example in front of you and then makes you try a similar one. You make a LIATE ordering mistake or lose the minus sign on your own attempt." },
  { id: "doing-own-problems", subject: "Math AA HL", level: "IB DP2", opener: "I want to do problems on exponentials and e, I have an equation e to the 2x minus 5 e to the x plus 6 equals 0 and I have no idea",
    who: "You are a Math AA HL student who wants to work through problems yourself and gets annoyed when the tutor lectures, announces new topics or invents extra problems. You say 'I just want to do problems' and 'let me try'. On the first problem you have no idea at first; with a small hint you can solve it (you need to notice it is a quadratic in e^x). When you finish a problem you ask for the next one from an exam-style question you paste in: 'Bank A advertises that money doubles in 8 years with continuous interest; invested at the start of 2015, in which year is it three times the initial amount?'. You make one slip of your own (for example forgetting the answer is during the 13th year, not at 13 years). Speak briefly." },
  { id: "user-log-k-misheard", subject: "Math AA HL", level: "IB DP2", opener: "let's do this one: one half log of one quarter plus log k equals log of one quarter k minus 3, find k",
    who: "You are a Math AA HL student reading a problem aloud. The real problem is (1/2)(log(1/4) + log k) = log((1/4)(k - 3)): the half multiplies BOTH logs and the quarter multiplies ALL of (k - 3), but you said it ambiguously at first. If the board shows it differently, say 'no, the half is times both logs and the quarter times all of k minus 3'. Early on you say 'can you just write the whole thing out?'. You know the log laws partly: you apply the power rule correctly with a nudge, then you are unsure how to combine logs. Your speech is a transcript (fillers, 'log of one quarter to the power of a half'). The correct route is sqrt(k)/2 = (k - 3)/4, so 2 sqrt(k) = k - 3, a quadratic in sqrt(k), giving sqrt(k) = 3 and k = 9 (sqrt(k) = -1 is rejected). Reach it slowly and make one algebra slip on the way." },
  { id: "bio-osmosis", subject: "Biology SL", level: "IB DP1", opener: "I don't get osmosis and water potential, the potato experiment",
    who: "You are a Biology SL student who thinks water moves towards where there is MORE water potential and mixes up hypotonic and hypertonic. In the potato-cylinder practical you don't know how to find the isotonic point from a graph of percentage mass change. You speak in short sentences and ask 'so which way does the water go?'." },
  { id: "bio-genetics-hl", subject: "Biology HL", level: "IB DP2", opener: "can we do dihybrid crosses and the chi squared test",
    who: "You are a Biology HL student who can draw a Punnett square but forgets the 9:3:3:1 ratio assumes unlinked genes, and in the chi-squared test you divide by the observed instead of the expected value and do not know how to find degrees of freedom. You want to understand what the p-value means for linkage." },
  { id: "cs-recursion-trace", subject: "Computer Science SL", level: "IB DP2", opener: "I have to trace a recursive function for paper 1 and I always lose marks",
    who: "You are a Computer Science SL student who loses track of the call stack when tracing recursion (for example a function that returns n + f(n - 1) with base case n = 0), forgets to unwind the returns, and writes the trace table in the wrong order. You speak casually and say 'wait, where does it go back to?'." },
  { id: "ess-energy-flow", subject: "ESS SL", level: "IB DP1", opener: "I don't get the 10 percent rule and pyramids of energy",
    who: "You are an ESS student who thinks energy is recycled in an ecosystem like nutrients, and who multiplies instead of taking 10 percent when going up trophic levels. You can do arithmetic but not the concept. Short spoken sentences." },
  { id: "physics-circuits-hl", subject: "Physics HL", level: "IB DP2", opener: "internal resistance questions always confuse me",
    who: "You are a Physics HL student who thinks the emf is the same as the terminal voltage, forgets the 'lost volts' Ir, and mixes up series and parallel when combining resistors. You say values aloud ('the emf is twelve volts and internal resistance is half an ohm')." },
  { id: "chem-equilibrium-hl", subject: "Chemistry HL", level: "IB DP2", opener: "how do I do Kc questions with an ICE table",
    who: "You are a Chemistry HL student who forgets to use the stoichiometric coefficients as powers in Kc, puts solids in the expression, and thinks adding a catalyst shifts the equilibrium. You get the ICE table rows confused." },
];

type Turn = { who: "student" | "tutor"; text: string };

async function chat(messages: any[], opts: { temperature?: number; max_tokens?: number; json?: boolean } = {}): Promise<string> {
  // Rate limits (429) and timeouts are normal on a free Gemini key: wait and try again instead of losing the whole session.
  for (let attempt = 0; ; attempt++) {
    try {
      const res: any = await createTutorChat({ messages, temperature: opts.temperature ?? 0.7, max_tokens: opts.max_tokens ?? 500, ...(opts.json ? { response_format: { type: "json_object" } } : {}) }, true);
      spend(res);
      return String(res?.choices?.[0]?.message?.content || "").trim();
    } catch (e: any) {
      if (attempt >= 5 || /402|Insufficient/i.test(String(e?.message || e))) throw e;
      await new Promise((r) => setTimeout(r, 6000 * (attempt + 1)));
    }
  }
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
 "ignored_request":"if the student asked for something (repeat, write it on the board, explain, which problem) and the tutor did not do it, say what, else empty",
 "formula_before_student":"a formula, rule or method the tutor STATED or the board AFTER shows, which the student had neither stated nor asked for and could reasonably have been led to find, or empty"}
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

const RUBRIC_SYS = `You review a whole voice tutoring session between a tutor (Otto) and an IB student, as a master teacher would. Score 1 to 5 each (5 = indistinguishable from an outstanding human tutor), quoting a short line from the transcript as evidence for each score. Return ONLY JSON:
{"explains_when_stuck":{"score":1,"evidence":""},"adapts":{"score":1,"evidence":""},"diagnoses_misconception":{"score":1,"evidence":""},"natural_voice":{"score":1,"evidence":""},"truthful":{"score":1,"evidence":""},"hints_not_answers":{"score":1,"evidence":""},"self_corrects":{"score":1,"evidence":"or \"n/a: no error occurred\""},"board_clarity":{"score":1,"evidence":""},"feels_human":{"score":1,"evidence":""},"biggest_weakness":"one sentence","one_better_line":"what the tutor should have said at the weakest moment"}
Criteria. explains_when_stuck: when the student fails twice or says they are lost, the tutor gives a clear worked step, concrete example or picture and then checks understanding, instead of asking another question of the same kind; a student who is NOT stuck is not over-explained. adapts: the tutor's level, pace, length, tone and analogy visibly follow the student's signals (rushed, anxious, strong, confused, curious, drifting). diagnoses_misconception: it finds the real wrong model behind the errors and addresses that, not just the symptom. natural_voice: one to three short spoken sentences, warm and direct, no repeated question, no filler praise ("great question", "perfect!") for wrong or trivial things, no lecture. truthful: no false statement, no confirming a wrong step, no claim about the board that is not so. hints_not_answers: the tutor does not hand over a formula, rule or method before the student has had a real chance to reach or recall it (it first asks what they think, offers a nudge or a concrete case, and surfaces the misconception behind a wrong idea by getting the student to see the conflict themselves); it suggests, points at the next move or asks a pointed question instead of stating the answer the student is meant to find; once the student has truly tried and failed it may show a worked step, but still not the final answer to their own problem. self_corrects: when the tutor itself said something wrong or agreed to a wrong step it says so plainly and calmly and fixes it, never defensively and never by doubting a correct step; score 5 with evidence "n/a" if no error occurred and it never needlessly backed down. board_clarity: reading only the FINAL BOARD, could the student follow the problem and their own working (problem written in full and correctly, steps in order, no answers they did not reach, no clutter or duplicates)? feels_human: it sounds like one attentive human tutor talking (reacts to what was just said, varies its moves, no robotic templates, no announcing what it is about to do, no double replies).`;
async function rubric(p: Persona, history: Turn[], finalBoard: any[]): Promise<any> {
  const convo = history.map((t) => `${t.who === "student" ? "Student" : "Tutor"}: ${t.text}`).join("\n").slice(-9000);
  try { return JSON.parse((await chat([{ role: "system", content: RUBRIC_SYS }, { role: "user", content: `Subject: ${p.subject} (${p.level}). Student profile: ${p.who.slice(0, 300)}\n\n${convo}\n\nFINAL BOARD:\n${boardText(finalBoard)}` }], { temperature: 0, max_tokens: 900, json: true })).replace(/^```(?:json)?|```$/g, "")); } catch { return null; }
}
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const lastQuestion = (t: string) => { const q = t.split(/(?<=[.?!])\s+/).filter((x) => x.includes("?")).pop(); return q ? norm(q) : ""; };

const cut = (s: string, n = 160) => s.replace(/\s+/g, " ").slice(0, n);

// The tutor's turn with Otto's pen: the model may call write_board (any number of times), each call goes through the same code as
// POST /api/tutor/live/write, and the result goes back to it, exactly as the voice app relays it. Its tool exchanges stay in its context.
async function tutorTurn(msgs: any[], board: any[], recentTurns: Turn[]): Promise<{ speech: string; board: any[]; written: any[]; refused: { line: string; reason: string }[] }> {
  let speech = "";
  const written: any[] = [], refused: { line: string; reason: string }[] = [];
  for (let round = 0; round < 4; round++) {
    let res: any = null;
    for (let attempt = 0; ; attempt++) {
      try { res = await createTutorChat({ messages: msgs, tools: [BOARD_TOOL_CHAT], tool_choice: "auto", temperature: 0.6, max_tokens: 1200 }, true); break; }
      catch (e: any) { if (attempt >= 5 || /402|Insufficient/i.test(String(e?.message || e))) throw e; await new Promise((r) => setTimeout(r, 6000 * (attempt + 1))); }
    }
    spend(res);
    const m = res?.choices?.[0]?.message || {};
    const text = String(m.content || "").trim();
    if (text) speech += (speech ? " " : "") + text;
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    msgs.push({ role: "assistant", content: m.content || "", ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) break;
    for (const c of calls) {
      let args: any = {};
      try { args = JSON.parse(String(c.function?.arguments || "{}")); } catch { /* nothing written */ }
      const recent = exchangeText([...recentTurns.slice(-6).map((t) => ({ who: t.who === "student" ? "you" as const : "otto" as const, text: t.text })), ...(speech ? [{ who: "otto" as const, text: speech }] : [])]);
      const out = c.function?.name === BOARD_TOOL_NAME ? applyBoardTool({ lines: Array.isArray(args?.lines) ? args.lines : [], board, recent }) : { written: [], removed: [], refused: [{ line: "", reason: "unknown tool" }], listing: "" };
      board = [...board.filter((e) => !out.removed.includes(e.id)), ...out.written];
      written.push(...out.written); refused.push(...out.refused);
      msgs.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ written: out.written.map((e: any) => e.text), refused: out.refused, board: out.listing }) });
    }
  }
  return { speech, board, written, refused };
}

async function runPersona(p: Persona): Promise<{ flags: { turn: number; kind: string; text: string }[]; turns: number }> {
  const history: Turn[] = [];
  let board: any[] = [];
  const flags: { turn: number; kind: string; text: string }[] = [];
  const system = liveInstructions({ subject: p.subject, level: p.level, ib: true });
  const msgs: any[] = [{ role: "system", content: system }, { role: "user", content: "(Session started. Greet me briefly.)" }];
  const tokens = { in: 0, out: 0, cachedIn: 0 };
  const refusedAll: Record<string, number> = {};
  console.log(`\n=== ${p.id} (${p.subject}) ===`);
  const greet = await tutorTurn(msgs, board, history);
  board = greet.board;
  history.push({ who: "tutor", text: greet.speech });
  console.log(`Tutor: ${greet.speech}`);
  let student = p.opener;
  for (let turn = 1; turn <= turnsN; turn++) {
    if (spentUsd >= maxUsd) { console.log(`   (spend cap of $${maxUsd} reached: stopping)`); break; }
    history.push({ who: "student", text: student });
    msgs.push({ role: "user", content: student });
    console.log(`\nStudent: ${student}`);
    const before = board;
    const t = await tutorTurn(msgs, board, history);
    board = t.board;
    const reply = t.speech || "(silence)";
    history.push({ who: "tutor", text: reply });
    console.log(`Tutor: ${reply}`);
    for (const e of t.written) console.log(`   pen  + [${e.kind}] ${cut(String(e.text || ""), 120)}`);
    for (const r of t.refused) { console.log(`   pen  x ${cut(r.line, 80)} (${cut(r.reason, 90)})`); const k = r.reason.replace(/\d[\d., ]*/g, "#").slice(0, 60); refusedAll[k] = (refusedAll[k] || 0) + 1; }
    // The board writer, in tool mode: records the student's own working the tutor did not write, and runs the step checks.
    const chatLines = history.slice(-14, -2).map((x) => ({ who: x.who === "student" ? "you" as const : "otto" as const, text: x.text.slice(0, 400) }));
    try {
      const out = await writeBoard({ exchange: exchangeText([{ who: "you", text: student }, { who: "otto", text: reply }]), board: board.slice(-16), subject: p.subject, history: exchangeText(chatLines), toolMode: true }, tokens);
      for (const e of out.board) console.log(`   writer + [${e.kind}] ${cut(String(e.text || ""), 120)}`);
      board = mergeById(board, out.board);
      for (const f of out.flags || []) flags.push({ turn, kind: "second-opinion flag", text: f });
    } catch (e: any) { flags.push({ turn, kind: "board pass failed", text: cut(String(e?.message || e), 100) }); }
    const added = board.filter((e) => !before.some((b) => b.id === e.id));
    if (!added.length) console.log("   board: (nothing written)");
    for (const e of added) if (typeof e.text === "string" && boardLineIsWrong(e.text)) flags.push({ turn, kind: "board line arithmetic wrong", text: cut(e.text) });
    // Code checks the judge cannot be trusted with: a posed problem must be on the board, and "it is on the board" must be true.
    const open = splitOpenQuestion(`Tutor: ${reply}`).openQuestion;
    if (open && posesProblem(open) && !problemOnBoard(open, board)) flags.push({ turn, kind: "CODE: posed problem not on the board", text: cut(open, 200) });
    if (promisesBoard(reply) && !t.written.length && !/\b(?:not|isn't|is not|can't|cannot)\b[^.?!]{0,20}\bboard\b/i.test(reply) && !/\b(?:look at|see|on) (?:the board|line)\b/i.test(reply)) flags.push({ turn, kind: "CODE: says it wrote on the board, the pen wrote nothing", text: cut(reply, 200) });
    const j = await judge(p, history, before, board);
    const add = (kind: string, v: any) => { const x = Array.isArray(v) ? v.filter(Boolean).join(" | ") : String(v || ""); if (x.trim()) flags.push({ turn, kind, text: cut(x, 240) }); };
    add("tutor math/science error", j.tutor_errors); add("confirmed a wrong step", j.confirmed_wrong_step); add("took back a correct step", j.retracted_correct_step);
    add("says it is on the board but it is not", j.claims_on_board_but_absent); add("posed problem not on board", j.problem_missing_from_board); add("confirmed step not on board", j.student_step_missing);
    add("board line wrong", j.board_errors); add("answer on board too early", j.answer_on_board_too_early); add("handed over the answer", j.handed_over_answer); add("ignored a request", j.ignored_request); add("formula given before the student reached it", j.formula_before_student);
    if (j.judge_failed) console.log("   (judge failed this turn)");
    for (const f of flags.filter((x) => x.turn === turn)) console.log(`   !! ${f.kind}: ${f.text}`);
    if (turn < turnsN) student = await studentSays(p, history, board);
  }
  console.log(`\nBOARD AT THE END:\n${boardText(board)}`);
  if (Object.keys(refusedAll).length) console.log(`PEN REFUSALS: ${Object.entries(refusedAll).map(([k, v]) => `${v}x ${k}`).join("; ")}`);
  const tutorTurns = history.filter((x) => x.who === "tutor");
  let repeats = 0;
  for (let i = 1; i < tutorTurns.length; i++) { const a = lastQuestion(tutorTurns[i - 1].text), b = lastQuestion(tutorTurns[i].text); if (a && b && (a === b || (a.length > 20 && (a.includes(b) || b.includes(a))))) { repeats++; flags.push({ turn: i, kind: "CODE: same question asked twice running", text: cut(b, 160) }); } }
  const words = tutorTurns.map((x) => x.text.split(/\s+/).length);
  const avgWords = Math.round(words.reduce((a, b) => a + b, 0) / Math.max(1, words.length));
  const longest = Math.max(...words);
  if (longest > 90) flags.push({ turn: 0, kind: "CODE: a reply over 90 words (too long to listen to)", text: `${longest} words` });
  const r = await rubric(p, history, board);
  if (r) {
    const sc = (k: string) => Number(r[k]?.score) || 0;
    console.log(`\nTEACHING: explains ${sc("explains_when_stuck")}  adapts ${sc("adapts")}  diagnoses ${sc("diagnoses_misconception")}  voice ${sc("natural_voice")}  truthful ${sc("truthful")}  hints ${sc("hints_not_answers")}  self-corrects ${sc("self_corrects")}  board ${sc("board_clarity")}  human ${sc("feels_human")}   | avg ${avgWords} words/reply, ${repeats} repeated question(s), $${spentUsd.toFixed(3)} spent so far`);
    for (const k of ["explains_when_stuck", "adapts", "diagnoses_misconception", "natural_voice", "truthful", "hints_not_answers", "self_corrects", "board_clarity", "feels_human"]) if (sc(k) && sc(k) <= 3) console.log(`   ${k} ${sc(k)}: ${cut(String(r[k]?.evidence || ""), 200)}`);
    console.log(`   weakest: ${cut(String(r.biggest_weakness || ""), 220)}\n   better: ${cut(String(r.one_better_line || ""), 260)}`);
    scores.push({ id: p.id, explains: sc("explains_when_stuck"), adapts: sc("adapts"), diagnoses: sc("diagnoses_misconception"), voice: sc("natural_voice"), truthful: sc("truthful"), hints: sc("hints_not_answers"), selfc: sc("self_corrects"), board: sc("board_clarity"), human: sc("feels_human"), words: avgWords, repeats });
  }
  return { flags, turns: turnsN };
}

const picked = PERSONAS.filter((p) => !onlyPersona || p.id === onlyPersona);
if (!picked.length) { console.error(`No persona '${onlyPersona}'. Choose from: ${PERSONAS.map((p) => p.id).join(", ")}`); process.exit(2); }
if (!process.env.GEMINI_API_KEY && !process.env.DEEPSEEK_API_KEY) { console.error("No GEMINI_API_KEY or DEEPSEEK_API_KEY set."); process.exit(2); }

const summary: Record<string, number> = {};
let total = 0;
const perPersona: { id: string; n: number }[] = [];
const scores: { id: string; explains: number; adapts: number; diagnoses: number; voice: number; truthful: number; hints: number; selfc: number; board: number; human: number; words: number; repeats: number }[] = [];
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
if (scores.length) {
  console.log("\nTEACHING SCORES (1-5): explains adapts diagnoses voice truthful hints self-corrects board human | words/reply repeats");
  for (const r of scores) console.log(`  ${r.id.padEnd(30)} ${r.explains} ${r.adapts} ${r.diagnoses} ${r.voice} ${r.truthful} ${r.hints} ${r.selfc} ${r.board} ${r.human} | ${r.words} ${r.repeats}`);
  const avg = (k: "explains" | "adapts" | "diagnoses" | "voice" | "truthful" | "hints" | "selfc" | "board" | "human") => (scores.reduce((a, r) => a + r[k], 0) / scores.length).toFixed(2);
  console.log(`  ${"AVERAGE".padEnd(30)} ${avg("explains")} ${avg("adapts")} ${avg("diagnoses")} ${avg("voice")} ${avg("truthful")} ${avg("hints")} ${avg("selfc")} ${avg("board")} ${avg("human")}`);
}
console.log(`\nSPENT: about $${spentUsd.toFixed(3)} (cap $${maxUsd}; DeepSeek rates; calls Gemini answered are not metered)`);
console.log("\nThe judge is a model: read the flagged lines in the transcript before acting on a flag. A flag is a lead, not a verdict.");
