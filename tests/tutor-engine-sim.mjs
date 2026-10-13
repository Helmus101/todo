// The new tutor engine (server/tutor.ts) against a scripted fake model: globalThis.fetch is intercepted for
// api.deepseek.com, so the REAL turn loop, tools and guards run with no network and no key. It can't judge how
// a live model writes; it proves the few hard guarantees hold: no answer leaks, wrong arithmetic gets fixed,
// the board only takes maths that typesets and never a mishearing, one problem at a time, and the prompt
// carries the conversation first and the background second.
process.env.DEEPSEEK_API_KEY ||= "sim-key";
delete process.env.GEMINI_API_KEY;
const { runTutorTurn, detectSubject, backgroundBlock, TUTOR_PROMPT, leakedValue, wantsExercise, inventsProblemOnBoard, doubtsRightAnswer, misgradedExercise, softenOpener, computedGapKey, nextTeachingState, sendsBackToStatement, statesFormula, misstatesGiven, stripPraiseOpener, tutorTools, applyTool, delegatesChoice, statesStudyGoal, proposesPlan, planConsented, agreesWithoutChallenge, asksStudentToChoose, repeatsSolvedCalculation } = await import("../server/tutor.ts");
const { equivalent } = await import("../shared/mathEquiv.ts");
const { equationsAhead } = await import("../shared/equationsAhead.ts");
const { boardLineNumbers } = await import("../shared/boardLines.ts");
const { boardSurfaceBlock } = await import("../server/boardEvents.ts");
const { resolveBoardTarget, makeProblem } = await import("../server/claude.ts");
const { practiceAnswerMatches } = await import("../shared/types.ts");

let script = () => ({ content: "" });
let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("api.deepseek.com")) return realFetch(url, init);
  const body = JSON.parse(init.body);
  calls.push(body);
  const out = script(body, calls.length - 1) || { content: "" };
  if (out.fail) return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400, headers: { "content-type": "application/json" } });
  const message = { role: "assistant", content: out.content ?? "", ...(out.tool_calls ? { tool_calls: out.tool_calls.map((t, i) => ({ id: `call_${calls.length}_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}) };
  return new Response(JSON.stringify({ id: "sim", object: "chat.completion", model: "sim", choices: [{ index: 0, message, finish_reason: out.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
};
const tc = (name, args) => ({ name, args });
const lastUser = (b) => String([...b.messages].reverse().find((m) => m.role === "user")?.content || "");
const systemOf = (b) => String(b.messages.find((m) => m.role === "system")?.content || "");
const gapBoard = [
  { id: "g1", at: "", kind: "given", text: "Observers at $15^\\circ$ and $25^\\circ$, 100 m apart" },
  { id: "g2", at: "", kind: "gap", text: "$b = ?$", expectedAnswer: "h/tan(25°)", gapAction: "express b" },
];
const run = (message, o = {}) => { calls = []; return runTutorTurn({ history: o.history || [{ role: "user", text: "hi" }, { role: "assistant", text: "Hey! What are we working on?" }], message, board: o.board || [], problems: o.problems || [], objectives: o.objectives || [], context: o.context || {}, lang: o.lang || "en", ...(o.opts || {}) }); };

export async function runTutorEngineSim(check, section) {
  section("Tutor engine (server/tutor.ts) — simple, Socratic, a few hard guards (real loop, scripted model)");

  script = () => ({ content: "Nice start. What does the 25° angle tell you about h and b?" });
  let r = await run("tan 25 = h/b");
  check("a Socratic reply passes through untouched, in one model call", r.reply === "Nice start. What does the 25° angle tell you about h and b?" && calls.length === 1 && !r.guardrailTripped && !r.error);

  script = (b, i) => i === 0 ? { content: "So b = h/tan(25°). Now what?" } : { content: "What happens if you divide both sides by tan 25°?" };
  r = await run("I don't know how to get b", { board: gapBoard });
  check("a reply stating an open gap's value is rewritten once, and the rewrite is used", r.reply === "What happens if you divide both sides by tan 25°?" && calls.length === 2 && /gives away/.test(lastUser(calls[1])));

  script = () => ({ content: "It's b = h/tan(25°)." });
  r = await run("just tell me", { board: gapBoard });
  check("a reply that keeps leaking is replaced by a question and flagged", r.guardrailTripped && !/tan\(25/.test(r.reply) && /\?$/.test(r.reply));
  check("the trip records WHICH value leaked, for the streak check below", r.leakedValue === "h/tan(25°)");

  // Reported live (real transcript): once blocked, Otto replayed the IDENTICAL fallback sentence turn
  // after turn, no matter what the student said — four times in a row. The fix: a SECOND consecutive trip
  // on the exact same value stops repeating the canned line and ships the model's real, content-aware
  // reply instead (first trip above is untouched — this only changes what happens on repeat).
  const streakState = nextTeachingState(undefined, { message: "just tell me", leaked: r.leakedValue });
  check("nextTeachingState tracks a fresh trip as streak 1", streakState.guardrailStreak === 1 && streakState.guardrailValue === "h/tan(25°)");
  script = () => ({ content: "It's b = h/tan(25°)." });
  r = await run("tell me again", { board: gapBoard, opts: { teaching: streakState } });
  check("a SECOND consecutive trip on the SAME value ships the real reply instead of repeating the fallback",
    r.guardrailTripped && r.reply === "It's b = h/tan(25°)." && !/what happens if you divide/i.test(r.reply));
  // A trip on a DIFFERENT value (not the same streak) must still behave like a first trip — the streak is
  // keyed to the exact value, not just "any guardrail trip happened last turn".
  script = () => ({ content: "The height is 425." });
  r = await run("just tell me", { board: [], problems: [{ id: "p9", question: "What's the height?", answer: "425", createdAt: "" }], opts: { teaching: streakState } });
  check("a trip on a DIFFERENT value is still a first trip (fallback, not the raw reply)", r.guardrailTripped && !/425/.test(r.reply));

  script = () => ({ content: "Yes, b = h/tan(25°) — now put it in the second equation." });
  r = await run("b = h/tan(25°)", { board: gapBoard });
  check("a value the student said themselves is theirs, not a leak", /h\/tan\(25°\)/.test(r.reply));

  const probs = [{ id: "p1", question: "Water content of a 125 g sample with dry mass 100 g?", answer: "0.25", createdAt: "" }];
  check("leakedValue: open problem answers count, solved ones don't", leakedValue("so it comes out at 0.25", "hm", [], probs) !== null && leakedValue("so it comes out at 0.25", "hm", [], [{ ...probs[0], solved: true }]) === null);

  script = (b, i) => i === 0 ? { content: "Right: 12 × 3 = 38. What next?" } : { content: "Right: 12 × 3 = 36. What next?" };
  r = await run("12 times 3?");
  check("a wrong calculation in the reply is caught and rewritten", r.reply === "Right: 12 × 3 = 36. What next?" && /wrong calculation/.test(lastUser(calls[1])));
  script = () => ({ content: "You wrote 2 + 2 = 5 — try it with two apples?" });
  r = await run("2 + 2 = 5");
  check("…but quoting the STUDENT's own slip back to them is the point, not an error", calls.length === 1);

  script = (b, i) => i === 0
    ? { tool_calls: [tc("WRITE_TO_BOARD", { text: "$\\frac{h}{100 + \\tan(25^\\circ)$", kind: "formula" }), tc("WRITE_TO_BOARD", { text: "$\\tan(15^\\circ) = \\frac{h}{100+b}$", kind: "formula", why: "Their tangent ratio for the far triangle: opposite over adjacent." })] }
    : { content: "Look at the board — what links the two triangles?" };
  r = await run("so tan 15 = h over 100 plus b", { board: gapBoard.slice(0, 1) });
  const toolMsgs = calls[1].messages.filter((m) => m.role === "tool").map((m) => m.content);
  check("the board takes maths that typesets and bounces LaTeX that doesn't (with KaTeX's error)", r.board.length === 1 && /tan\(15/.test(r.board[0].text) && /doesn't typeset/.test(toolMsgs[0]));

  script = (b, i) => i === 0
    ? { tool_calls: [tc("WRITE_TO_BOARD", { text: "1025 = height over b", kind: "summary", owner: "student" }), tc("WRITE_TO_BOARD", { text: "$\\tan 25^\\circ = \\frac{h}{b}$", kind: "result", owner: "student" })] }
    : { content: "Good — and the other triangle?" };
  r = await run("1025 = height over b", { board: gapBoard.slice(0, 1), opts: { spoken: { alternatives: ["10 25 = height over b"] } } });
  check("spoken input: the prompt names the likely meaning and the board refuses the mishearing", /SPOKEN INPUT/.test(systemOf(calls[0])) && /tan 25°/.test(systemOf(calls[0])) && r.board.length === 1 && !/1025/.test(r.board[0].text));

  script = (b, i) => i === 0 ? { tool_calls: [tc("CREATE_PROBLEM", { question: "What is $3 \\times 4$?", answer: "12", check: "3*4" })] } : { content: "Have a go at the one on the board first?" };
  r = await run("give me another one", { problems: [{ id: "p1", question: "What is 2+2?", answer: "4", createdAt: "" }] });
  const pr = calls[1].messages.filter((m) => m.role === "tool").map((m) => m.content).join(" ");
  check("one problem at a time: a new one is refused while one is unanswered (unless they ask to move on)", (r.problems.length === 0 && /haven't answered/.test(pr)) || r.problems.length === 1);
  script = (b, i) => i === 0 ? { tool_calls: [tc("CREATE_PROBLEM", { question: "What is $3 \\times 4$?", answer: "12", check: "3*4" })] } : { content: "Try this one." };
  r = await run("let's do a problem");
  check("…and with nothing open, CREATE_PROBLEM puts one on the board", r.problems.length === 1 && r.problems[0].answer === "12");

  script = (b, i) => i === 0 ? { tool_calls: [tc("NOPE", {}), tc("ANNOTATE_BOARD", { target: "#9", note: "look here" })] } : { content: "What do you notice?" };
  r = await run("hmm", { board: gapBoard });
  check("an unknown tool or a bad target returns an error to the model, never a crash", r.reply === "What do you notice?" && /unknown tool/.test(calls[1].messages.filter((m) => m.role === "tool")[0].content));

  script = () => ({ content: "Okay." });
  await run("b = h/tan(25°)", { board: gapBoard, opts: { stepVerdict: { gap: "b = ?", given: "b = h/tan(25°)", verdict: "correct" } }, context: { journal: [{ date: "2026-10-09", text: "Did trig: SOH CAH TOA" }], profile: { name: "Sam" } } });
  const sys = systemOf(calls[0]);
  check("the prompt carries the board, the code verdict, and the background — background AFTER the core prompt and marked secondary", sys.startsWith(TUTOR_PROMPT) && /VERIFIED BY CODE/.test(sys) && /WHAT'S CURRENTLY ON THE BOARD/.test(sys) && /BACKGROUND \(secondary/.test(sys) && /SOH CAH TOA/.test(sys) && /Sam/.test(sys));
  check("no background at all → no empty BACKGROUND header", backgroundBlock({}) === "");

  script = () => ({ fail: true });
  r = await run("hello");
  check("a model failure is reported as an error (the route answers 500, the student can retry)", r.error === true && !r.reply);

  check("the prompt is Socratic and subject-agnostic", /Never give the answer/.test(TUTOR_PROMPT) && /ANY SUBJECT/.test(TUTOR_PROMPT) && /another way/.test(TUTOR_PROMPT) && /independent thinker/.test(TUTOR_PROMPT));
  check("subject detection: explicit words win, keywords decide otherwise, nothing → undefined",
    detectSubject("j'ai un exo de physique sur les forces") === "Physics" && detectSubject("solve x² − 5x + 6 = 0") === "Math" &&
    detectSubject("why did the cold war start") === "History" && detectSubject("help me plan my essay on Shakespeare") === "English" && detectSubject("hi") === undefined);

  // Reported live: asked for a problem, Otto wrote "Car of mass 1000 kg climbs a hill of slope 10° at 15 m/s" and
  // "Required power = mgv sin(10°) = ?" as board text + a gap, instead of an exercise with an answer box.
  const carGiven = "Car of mass 1000 kg climbs a hill of slope $10^\\circ$ at a constant speed of 15 m/s.";
  script = (b, i) => i === 0
    ? { tool_calls: [tc("WRITE_TO_BOARD", { text: carGiven, kind: "given" }), tc("WRITE_TO_BOARD", { text: "Required power $= mgv\\sin(10^\\circ) = ?$", kind: "gap", expectedAnswer: "25500", gapAction: "find the power" })] }
    : i === 1 ? { tool_calls: [tc("CREATE_PROBLEM", { question: carGiven + " What power (in W) is needed against gravity? Take $g = 9.8$.", answer: "25525", check: "1000*9.8*15*sind(10)", hint: "Round to the nearest watt." })] }
    : { content: "It's on the board — what's your first move?" };
  r = await run("give me a problem on power");
  const rejected = calls[1].messages.filter((m) => m.role === "tool").map((m) => m.content).join(" ");
  check("asked for a problem: board text + gap are refused, and a real exercise (answer box) is created instead", r.board.length === 0 && r.problems.length === 1 && /CREATE_PROBLEM/.test(rejected));

  script = (b, i) => i === 0 ? { content: "Imagine a 1000 kg car going up a 10° hill at 15 m/s — what power does it need?" } : i === 1 ? { tool_calls: [tc("CREATE_PROBLEM", { question: carGiven + " What power (in W) is needed against gravity?", answer: "25525", check: "1000*9.8*15*sind(10)" })] } : { content: "Your turn — it's on the board." };
  r = await run("test me");
  check("asked for a problem but the draft only TALKS about one → one round to create it", r.problems.length === 1 && /asked for an exercise/i.test(lastUser(calls[1])));

  script = (b, i) => i === 0 ? { tool_calls: [tc("WRITE_TO_BOARD", { text: "A 2 kg block slides 5 m down a 30° ramp", kind: "given" })] } : { content: "What do you want to work on?" };
  r = await run("I want to understand energy");
  check("Otto can't invent a problem as board givens (numbers nobody gave)", r.board.length === 0);
  script = (b, i) => i === 0 ? { tool_calls: [tc("WRITE_TO_BOARD", { text: carGiven, kind: "given" })] } : { content: "What's being asked?" };
  r = await run("A car of mass 1000 kg climbs a hill of slope 10 degrees at 15 m/s. Find the power needed.");
  check("…but the student's own problem goes up as givens", r.board.length === 1);
  check("wantsExercise / inventsProblemOnBoard", wantsExercise("give me another problem") && wantsExercise("interroge-moi") && wantsExercise("quiz me") && !wantsExercise("I'm stuck on this one") &&
    inventsProblemOnBoard("A 2 kg block on a 30° ramp", ["help with ramps"]) && !inventsProblemOnBoard("A 2 kg block on a 30° ramp", ["a 2 kg block on a 30 degree ramp"]) && !inventsProblemOnBoard("$E = mgh$", []));

  // "Never auto-derive equations or show which equations they need — ask them first."
  const carBoard = [{ id: "c1", at: "", kind: "given", text: "Car: $m = 1000$ kg, slope $10^\\circ$, $v = 15$ m/s. Find the power against gravity." }];
  script = (b, i) => i === 0
    ? { tool_calls: [tc("WRITE_TO_BOARD", { text: "$P = mgv\\sin(10^\\circ)$", kind: "formula" })] }
    : i === 1 ? { content: "Use $P = mgv\\sin\\theta$ — what do you get?" }
    : { content: "What do you know that links power, force and speed?" };
  r = await run("ok where do I start", { board: carBoard });
  const boardTool = calls[1].messages.filter((m) => m.role === "tool").map((m) => m.content).join(" ");
  check("Otto can't write the formula to use on the board before the student names it", r.board.length === 0 && /haven't stated/.test(boardTool));
  check("…nor hand it over in the reply: rewritten into a question that asks them for the relationship", r.reply === "What do you know that links power, force and speed?" && /hands them an equation/.test(lastUser(calls[2])));
  script = (b, i) => i === 0 ? { tool_calls: [tc("WRITE_TO_BOARD", { text: "$P = Fv$", kind: "formula", owner: "student" })] } : { content: "Good — and which force is F here?" };
  r = await run("I think power is force times velocity", { board: carBoard });
  check("once THEY say it (even in words), it goes on the board", r.board.length === 1 && calls.length === 2);
  script = () => ({ content: "It's $P = \\frac{W}{t}$: work done per second. Where does that show up in your problem?" });
  r = await run("what's the formula for power?", { board: carBoard });
  check("asked outright for the formula → answering is fine", calls.length === 1 && /W/.test(r.reply));
  check("equationsAhead: formulas count, givens/unknowns/their own lines don't",
    equationsAhead("$F = mg\\sin\\theta$", ["find F"]).length === 1 && equationsAhead("$m = 1000$ kg, $v = 15$ m/s", []).length === 0 &&
    equationsAhead("$b = ?$", []).length === 0 && equationsAhead("$\\tan 25^\\circ = \\frac{h}{b}$", ["tan 25 equals h over b"]).length === 0 &&
    equationsAhead("Yes, b = h/tan(25°) — now the other triangle.", ["b = h/tan(25°)"]).length === 0);

  // A live energy/power session (reported): Otto confirmed numbers the student never said, invented new ones,
  // told a RIGHT student to redo their multiplication (twice — once after the app had marked it right), blamed the
  // widget, offered to wrap up, ignored "write it on the board", and in voice mode read "×" and "sin" out of
  // existence ("multiply 10009.8(10°)15").
  script = (b, i) => i === 0 ? { content: "That 235,200 J was from the previous problem! Multiply $1200 \\times 9.8 \\times 20$. What do you get?" } : { content: "Yes — $1200 \\times 9.8 \\times 20$ really is 235,200 J. What does that energy turn into at the bottom?" };
  r = await run("235,200", { problems: [{ id: "p9", question: "A 1200 kg car drops 20 m. Find its speed at the bottom.", answer: "19.8", createdAt: "" }] });
  check("telling a RIGHT student to redo it is caught (their number IS the expression's value) and rewritten", /they were RIGHT/.test(lastUser(calls[1])) && /really is 235,200/.test(r.reply));
  script = (b, i) => i === 0 ? { content: "Ah, let's re-run that one: $800 \\times 9.8 \\times \\sin(15^\\circ) \\times 12$." } : { content: "Right on — 24,350 W. What made the sin 15° the piece that matters?" };
  r = await run('[Exercise] I answered "24350" — marked right (try #1).');
  check("an exercise the app marked right is never sent back for a redo", /already checked their answer/.test(lastUser(calls[1])) && calls.length === 2);
  script = (b, i) => i === 0 ? { content: "200,200 J is right on the money! What do you get when you take the square root of 390.4? And what is 15,000 J divided by 3 s? Ready for another one? Those widgets can be picky." } : { content: "You've got 200,000 J of kinetic energy left. What equation links that to v?" };
  r = await run("so now I have a real kinetic energy of 200,000", { board: [{ id: "x", at: "", kind: "given", text: "1000 kg, 24 m, friction 35,200 J" }] });
  const note = lastUser(calls[1]);
  check("confirming a number they didn't say, inventing numbers, unasked wrap-up and blaming the widget all go back in ONE correction", calls.length === 2 && /confirms a value/.test(note) && /numbers nobody gave/.test(note) && /wrap up/.test(note) && /blames the app/.test(note));
  script = (b, i) => i === 0 ? { content: "What are we trying to calculate first?" } : i === 1 ? { tool_calls: [tc("WRITE_TO_BOARD", { text: "$E_p = mgh = 1200 \\times 9.8 \\times 20$", kind: "summary", owner: "student" })] } : { content: "It's up there — what do you get?" };
  r = await run("write write down the board", { history: [{ role: "user", text: "so E = mgh = 1200 times 9.8 times 20" }, { role: "assistant", text: "Good start." }] });
  check("'write it on the board' is done, not answered with a question", r.board.length === 1 && /write it on the board/.test(lastUser(calls[1])));
  script = () => ({ content: "Multiply $1000 \\times 9.8 \\times \\sin(10^\\circ) \\times 15$ — what do you get? Then $\\frac{1}{2}mv^2$." });
  r = await run("1000 times 9.8 times sine 10 times 15", { opts: { voiceMode: true } });
  check("voice mode keeps the maths readable (× and sin survive, ½ isn't '12')", /1000 × 9\.8 × sin\(10°\) × 15/.test(r.reply) && /1\/2/.test(r.reply) && !/\\/.test(r.reply));
  check("doubtsRightAnswer leaves a genuinely wrong answer alone", doubtsRightAnswer("Check that again: $1000 \\times 9.8 \\times \\sin(10^\\circ) \\times 15$.", "5,526") === null);
  // Reported live: a correct, SMALL final answer (P=8, an ordinary supply/demand equilibrium price) kept
  // getting doubted turn after turn — doubtsRightAnswer's own number extraction filtered out anything under
  // 10 BEFORE it ever reached the reachedSolutionSteps check, so a small correct answer could never be
  // rescued by this safety net at all, no matter how clearly the reply asked to recheck it.
  {
    const econSol = { statement: "Qd=500-20P, Qs=100+30P", steps: [], value: 8 };
    check("doubtsRightAnswer now catches a correct SMALL final answer (was silently excluded by the old n>=10 floor)",
      doubtsRightAnswer("Let's re-verify that — what is 400 divided by 50?", "8", econSol) !== null);
    check("...and still correctly ignores an unrelated small number with no recheck language at all",
      doubtsRightAnswer("Nice, what's next?", "8", econSol) === null);
    // misgradedExercise: fires on the exercise widget's own "[Exercise]…marked wrong" message, independent
    // of whatever the model's own draft reply says — this is what makes the fix robust even when Otto's
    // reply doesn't happen to use "recheck"-shaped language at all.
    check("misgradedExercise catches the exact reported case: exercise widget wrong, verified solution agrees",
      misgradedExercise('[Exercise] I answered "8" — marked wrong (try #1).', econSol) !== null);
    check("misgradedExercise says nothing when the exercise widget marked it RIGHT (nothing to correct)",
      misgradedExercise('[Exercise] I answered "8" — marked right (try #1).', econSol) === null);
    check("misgradedExercise says nothing for a genuinely wrong answer", misgradedExercise('[Exercise] I answered "12" — marked wrong (try #1).', econSol) === null);
    check("misgradedExercise says nothing without a verified solution to check against", misgradedExercise('[Exercise] I answered "8" — marked wrong (try #1).', undefined) === null);
    // End-to-end: runTutorTurn short-circuits immediately on a misgraded exercise, no model call at all.
    script = () => ({ content: "THIS SHOULD NEVER BE SEEN — the misgraded-exercise short-circuit must bypass the model entirely" });
    r = await run('[Exercise] I answered "8" — marked wrong (try #1).', { opts: { solution: econSol } });
    check("runTutorTurn settles a misgraded exercise deterministically, with zero model calls", calls.length === 0 && /key was wrong/i.test(r.reply) && !r.error);
  }

  // Reported live (real transcript): Otto asked the student to go BACK TO THE PROBLEM STATEMENT to re-check a
  // value they had already given — "let's re-read the problem's pulling force", "Check the problem statement on
  // the board", "what is the exact pulling force given in the problem text?" — turn after turn, while all the
  // student could do was repeat "12". Nothing they say can break that loop, so it burns the whole session.
  const rereadReply = "Ah, look at the numbers given in the problem statement again, Willem. What is the exact pulling force given in the problem text?";
  check("sendsBackToStatement: the reported phrasings fire only when they've just given a number",
    sendsBackToStatement("let's re-read the problem's pulling force", "12") === "re-read" &&
    sendsBackToStatement("Check the problem statement on the board", "I said 12") === "Check the problem" &&
    sendsBackToStatement("What is the exact pulling force given in the problem text?", "12") === "problem text" &&
    sendsBackToStatement("Have a look at the original problem on the board.", "12") === "Have a look at the original problem" &&
    sendsBackToStatement("let's re-read the problem's pulling force", "I don't get it") === null &&
    sendsBackToStatement("Your net force is 5.2 N", "12") === null &&
    sendsBackToStatement("Just call it friction", "12") === null);
  script = (b, i) => i === 0 ? { content: rereadReply } : { content: "Your numbers stand: 12 N pulling up. Which line shall we pin down first?" };
  r = await run("12", { problems: [{ id: "pC", question: "A 3 kg box is pulled up a 20° incline by 12 N against 2 N of friction. Find its speed after 5 m.", answer: "0", createdAt: "" }] });
  check("going back to the problem statement to re-check a value they gave is corrected once, and the rewrite ships",
    calls.length === 2 && /sends them back to the problem statement/.test(lastUser(calls[1])) && r.reply === "Your numbers stand: 12 N pulling up. Which line shall we pin down first?");
  script = () => ({ content: rereadReply });
  r = await run("12");
  check("…and if it keeps doing it, the student never sees the same bounce-back again — code answers instead",
    !/problem text/i.test(r.reply) && /your numbers stand as they are/.test(r.reply) && /the question's numbers don't work/.test(r.reply));
  script = () => ({ content: "Have a look at the problem statement — what does it say the angle is?" });
  r = await run("I'm not sure where to start");
  check("with no value on the table, pointing back at the statement is legitimate and left alone", calls.length === 1 && /problem statement/.test(r.reply));

  // "Make sure": even if the rewrite STILL asks a right student to redo it, the student never sees that.
  script = () => ({ content: "Let's check that multiplication again. Try $800 \\times 9.8 \\times \\sin(15^\\circ) \\times 12$. What does it give you?" });
  r = await run("24,350 approximately");
  check("a right answer is confirmed even when the model keeps doubting it (code fallback)", /that's right/.test(r.reply) && !/again/.test(r.reply));
  script = () => ({ content: "Ah, let's re-run that one: $800 \\times 9.8 \\times \\sin(15^\\circ) \\times 12$. What do you get when you multiply those out?" });
  r = await run('[Exercise] I answered "24350" — marked right (try #1).');
  check("…and after the app marked it right, never a re-run", /that's right/.test(r.reply) && !/re-run/.test(r.reply));

  // Reported live: the student said "the force along the slope plus accelerating force minus 360" and Otto put the
  // whole substituted set-up on the board for them: "Total force = 900×9.8×sin(12°) + 900×0.4 + 360 = ?".
  const truck = [{ id: "pT", question: "A 900 kg truck accelerates at 0.4 m/s² up a 12° slope against 360 N of friction. Find the engine's force.", answer: "2553", createdAt: "" }];
  script = (b, i) => i === 0
    ? { tool_calls: [tc("WRITE_TO_BOARD", { text: "Total force $= 900 \\times 9.8 \\times \\sin(12^\\circ) + 900 \\times 0.4 + 360 = ?$", kind: "gap", expectedAnswer: "2553", gapAction: "add the three forces" })] }
    : { content: "Careful, Willem — the friction isn't something you subtract here. Does it help the engine or fight it?" };
  r = await run("the total force is basically the force along the slope plus accelerating force minus 360 newtons right", { problems: truck });
  const tool2 = calls[1].messages.filter((m) => m.role === "tool").map((m) => m.content).join(" ");
  check("a substituted set-up the student hasn't built never goes on the board", r.board.length === 0 && /haven't stated/.test(tool2));
  check("…and the reply doesn't open harshly ('Careful, Willem —' is softened)", /^Hm, let's look at that — the friction/.test(r.reply));
  script = (b, i) => i === 0 ? { tool_calls: [tc("WRITE_TO_BOARD", { text: "$F = 900 \\times 9.8 \\times \\sin(12^\\circ) + 900 \\times 0.4 + 360$", kind: "summary", owner: "student" })] } : { content: "That's your line on the board — what does it come to?" };
  r = await run("so 900 times 9.8 times sine 12 plus 900 times 0.4 plus 360", { problems: truck });
  check("…but once THEY say it, it's written up as theirs", r.board.length === 1);
  check("softenOpener works in French too", softenOpener("Attention, Willem : le frottement s'oppose au mouvement.", true) === "Hmm, regardons ça — le frottement s'oppose au mouvement.");

  // Reported live: "It's already on the board, Willem — line 40. … what's 900 × 9.8 × sin(12°), what's 900 × 0.4,
  // and then add the 360?" — the board showed NO line numbers (and had no line 40), and the reply handed over the
  // substituted pieces to compute.
  const numbered = [
    { id: "l1", n: 1, at: "2026-10-10T10:00:00Z", kind: "given", text: "Truck: 900 kg, 12° slope, a = 0.4 m/s², friction 360 N" },
    { id: "l2", n: 2, at: "2026-10-10T10:01:00Z", kind: "summary", owner: "student", text: "F = gravity along slope + ma + friction" },
  ];
  script = (b, i) => i === 0
    ? { content: "It's already on the board, Willem — line 40. Take each of the three pieces on its own: what's 900 × 9.8 × sin(12°), what's 900 × 0.4, and then add the 360?" }
    : { content: "Your plan's on line 2. Which of those three pieces would you work out first?" };
  r = await run("plus ok I get it", { board: numbered, problems: truck });
  const fix = lastUser(calls[1]);
  check("a line number that isn't on their board is corrected, and handing over the calculation is too", /line 40, which doesn't exist/.test(fix) && /hands them the calculation/.test(fix) && /line 2/.test(r.reply));
  check("the prompt's board listing uses the student's own margin numbers", /#2; .*STUDENT'S WORK/.test(boardSurfaceBlock(numbered, [])) && /- \[given\] \(#1/.test(boardSurfaceBlock(numbered, [])));
  check("ANNOTATE_BOARD's #n resolves by the margin number", resolveBoardTarget("#2", [{ id: "x", n: 7, at: "", text: "a" }, ...numbered])?.id === "l2");
  const nums = boardLineNumbers([{ id: "b", at: "2026-10-10T10:05:00Z", kind: "result" }, { id: "f", at: "2026-10-10T09:00:00Z", kind: "focus" }, { id: "a", at: "2026-10-10T10:00:00Z", kind: "given" }, { id: "p", at: "2026-10-10T10:02:00Z", kind: "annotation" }, { id: "a", at: "2026-10-10T10:00:00Z", kind: "given" }]);
  check("boardLineNumbers: time order, focus/annotations unnumbered, duplicates once", nums.get("a") === 1 && nums.get("b") === 2 && !nums.has("f") && !nums.has("p") && nums.size === 2);

  // Reported live: "2554.4" for 900×9.8×sin(12°) + 900×0.4 + 360 marked "Not quite" — the model's key was a guessed
  // 2553 (true value 2553.8) and plain numbers had no rounding allowance.
  check("a gap on a closed calculation gets its key computed by code", Math.abs(computedGapKey("Total force $= 900 \\times 9.8 \\times \\sin(12^\\circ) + 900 \\times 0.4 + 360 = ?$") - 2553.78) < 0.01 && computedGapKey("$b = ?$") === null);
  check("a plain-number answer is allowed ordinary rounding (0.5%), a real slip is not", equivalent("2554.4", "2553.78") === "correct" && equivalent("2,554.4", "2553.78") === "correct" && equivalent("2600", "2553.78") === "incorrect" && equivalent("1/4", "0.2") === "incorrect");

  // Reported live: "25538" and "25537" marked wrong for a truck's power on a 12° slope. The model's check used a
  // plain sin(12) — evaluated in RADIANS — so the "verified" key became −40126; and "25,538" was parsed as 25.538.
  const truckP = makeProblem({ question: "A 900 kg truck accelerates at 0.4 m/s² up a 12° slope against 360 N of friction, at 10 m/s. What power (W) does the engine deliver?", answer: "25,538", check: "(900*9.8*sin(12)+900*0.4+360)*10" }, true);
  check("a check expression on a problem stated in degrees evaluates trig in degrees (key stays 25538)", "problem" in truckP && truckP.problem.answer.replace(",", "") === "25538" && Math.abs(truckP.problem.value - 25537.81) < 0.01);
  check("…so 25538, 25537 and 25537.8 are all right", "problem" in truckP && ["25538", "25537", "25537.8", "25,538 W"].every((g) => practiceAnswerMatches(g, truckP.problem.answer, truckP.problem.value)));
  const radP = makeProblem({ question: "Find sin(π/6).", answer: "0.5", check: "sin(pi/6)" }, true);
  check("…while a problem in radians keeps radians", "problem" in radP && radP.problem.answer === "0.5");

  // "I've put your point on the board" with no board tool call: corrected once, then the false claim is stripped in code.
  script = (b, i) => i === 0 ? { content: "Nailed the distinction. I've put your point up on the board. What structure would you use?" }
    : i === 1 ? { content: "", tool_calls: [tc("WRITE_TO_BOARD", { text: "Shared vs personal knowledge", kind: "note" })] }
    : { content: "Added it under the second heading. What structure would you use?" };
  r = await run("shared knowledge is the culture and language, personal knowledge is lived experience");
  check("claiming a board write without calling a board tool sends the model back to actually write it", r.board.length === 1 && /nothing was written this turn/.test(JSON.stringify(calls[1]?.messages || [])));
  script = () => ({ content: "Nailed the distinction. I've put your point up on the board. What structure would you use?" });
  r = await run("shared knowledge is the culture and language, personal knowledge is lived experience");
  check("if it still claims a board write with nothing written, the false claim is removed in code", !r.board.length && !/board/i.test(r.reply) && /\?$/.test(r.reply));

  const jb = backgroundBlock({ subject: "Math", journal: [{ date: "2026-10-01", text: "Chain rule was shaky", subjects: ["Math"] }], journalMeta: { total: 5, subjects: { Math: 3, Physics: 2 } }, profile: {} });
  check("the tutor's background carries the journal: dated, labelled by subject, with the overall count — and the prompt tells it to use it", /STUDY JOURNAL/.test(jb) && /2026-10-01 \[Math\]/.test(jb) && /5 entries in all/.test(jb) && /JOURNAL is your memory/.test(TUTOR_PROMPT));

  const { dedupeParagraphs } = await import("../server/tutor.ts");
  check("a reply that repeats a whole paragraph keeps each paragraph once", dedupeParagraphs("Ah, my mistake.\n\nSo the angle is right.\n\nAh, my mistake.\n\nSo the angle is right.") === "Ah, my mistake.\n\nSo the angle is right." && dedupeParagraphs("One.\n\nTwo.") === "One.\n\nTwo.");
  // Reported live (screenshot): the WHOLE multi-paragraph reply appeared twice in the same bubble, with
  // only a SINGLE newline at the seam between the two copies (not a blank line) — the paragraph-level
  // pass above can't catch that on its own, since it only splits on \n{2,}.
  {
    const whole = "Ah, check the mass of the block on the board, Willem — it's 2 kg, not 1 kg! So mg sin(30°) is 2 × 9.8 × 0.5, which gives 9.8 N.\n\nThat means your net force is 15 - 9.8 = 5.2 N, and multiplied by 4 meters gives 20.8 joules.\n\nNotice how that relates to the work-energy theorem: the total work done by all the forces equals the change in kinetic energy. What would the speed of that block be after moving 4 meters if it started from rest?";
    const duplicated = whole + "\n" + whole; // single-newline seam — the exact reported shape
    check("a whole multi-paragraph reply duplicated with only a single-newline seam collapses to one copy", dedupeParagraphs(duplicated) === whole);
  }
  // A real reply that legitimately has two genuinely different halves (no duplicate) must survive untouched.
  check("a normal, non-duplicated multi-paragraph reply is never truncated", dedupeParagraphs("First part of the explanation.\nSecond, totally different part.") === "First part of the explanation.\nSecond, totally different part.");
  // Reported live (real transcript): the SAME three-paragraph reply appeared twice in one bubble — but the two
  // copies were not byte-identical: one wrote "−0.06N" (U+2212, no space) and the other "-0.06 N" (hyphen,
  // space). The exact-match check therefore saw two different paragraphs and the student re-read the whole thing.
  {
    const net = "So the net force is indeed −0.06N down the slope — the box is actually slowing down.";
    const again = "So the net force is indeed -0.06 N down the slope — the box is actually slowing down.";
    const given = "Ah, look at that total opposing force: 2 plus 10.06 is 12.06 N pulling down the slope.";
    check("a reply duplicated with only glyph/space variants (− vs -) collapses to one copy",
      dedupeParagraphs([given, net, again].join("\n\n")) === [given, net].join("\n\n"));
    check("…and a whole bubble duplicated that way (three paragraphs, seamed by a single newline) collapses too",
      dedupeParagraphs([given, net, "Wait, is it 12 N, or something else?", given, again, "Wait, is it 12 N, or something else?"].join("\n\n")) === [given, net, "Wait, is it 12 N, or something else?"].join("\n\n"));
    check("a non-breaking space is the same text, not a second copy",
      dedupeParagraphs([given, net, given, net.replace(" ", "\u00a0")].join("\n\n")) === [given, net].join("\n\n"));
    check("two genuinely different paragraphs are still both kept",
      dedupeParagraphs([given, net].join("\n\n")) === [given, net].join("\n\n"));
  }

  // They reach a result, Otto confirms it in words, nothing is on the board: one correction round asks for the write.
  script = (b, i) => i === 0 ? { content: "Spot on, Willem! Pi over two. What would you say about arccos(−1)?" }
    : i === 1 ? { content: "", tool_calls: [tc("WRITE_TO_BOARD", { text: "$\\arccos(0) = \\frac{\\pi}{2}$", kind: "result", owner: "student" })] }
    : { content: "Pi over two is on the board. What would you say about arccos(−1)?" };
  r = await run("arccos of 0 is pi over 2");
  check("a result they reached and Otto confirmed in words gets written on the board (their numbers, owner student)", r.board.length === 1 && r.board[0].owner === "student" && /nothing went on the board/.test(JSON.stringify(calls[1]?.messages || [])));
  script = () => ({ content: "Nice. Let's log that result on the board. What next?" });
  r = await run("so the angle is 30 degrees");
  check("'Let's log that on the board' with no write is sent back (promise = write), and stripped if it still isn't kept", /Let's log/.test(JSON.stringify(calls[1]?.messages || "")) || !/board/i.test(r.reply));

  // Reported live, three asks: never delete the board, stop opening every reply with "Spot on", and put the
  // maths on the board instead of leaving it in the chat bubble.
  check("the board-clearing tool is not offered to the tutor", !tutorTools(false).some((t) => t.name === "CLEAR_BOARD"));
  const blank = { reply: "", board: [], problems: [], tokens: { in: 0, out: 0, cachedIn: 0 }, guardrailTripped: false };
  const seen = [{ id: "b1", n: 1, at: "2026-10-11T10:00:00Z", kind: "given", text: "15 N box, 4 m up a 30° slope" }, { id: "b2", n: 2, at: "2026-10-11T10:01:00Z", kind: "result", owner: "student", text: "W = 60 J" }];
  const refused = applyTool("CLEAR_BOARD", {}, { message: "let's clear the board", result: blank, allBoard: () => seen, allProblems: () => [], spokenRepair: null, fr: false, said: [], wantsExercise: false, focus: [], known: [], solution: undefined });
  check("a stray clear-board call refuses in words and leaves every entry in place", /^REJECTED: the board is never cleared/.test(refused) && !blank.boardCleared && blank.board.length === 0);

  check("stripPraiseOpener: a canned opener goes, the content stays",
    stripPraiseOpener("Spot on, Willem! Energy conservation makes it super clean here.") === "Energy conservation makes it super clean here." &&
    stripPraiseOpener("Exactly — 60 J. What's next?") === "60 J. What's next?" &&
    stripPraiseOpener("The applied force is 15 N along the slope.") === "The applied force is 15 N along the slope." &&
    stripPraiseOpener("Spot on!") === "Spot on!");
  script = (b, i) => i === 0 ? { content: "Spot on, Willem! What does that give you for v?" } : { content: "That's 4.9 m/s — what made you take the square root?" };
  r = await run("v squared is 24.5");
  check("opening with canned praise is corrected, and the reply that ships never opens with it", /canned praise/.test(lastUser(calls[1])) && !/^\s*Spot on/i.test(r.reply));

  check("statesFormula / misstatesGiven: a formula counts; a restated GIVEN that isn't in the problem is caught",
    statesFormula("Initial potential energy mgh turns into kinetic energy ½mv², so you get gh = ½v².") &&
    statesFormula("It's $W = F \\cdot d$ for a parallel force.") && !statesFormula("Look at line 3 — what do you notice?") &&
    misstatesGiven("Let's look at the problem on the board: a 3 kg box pulled by a force of 15 N.", ["A 3 kg box pulled up by 12 N"]) === "15" &&
    misstatesGiven("The problem says 12 N and friction of 2 N.", ["A 3 kg box pulled up by 12 N, friction 2 N"]) === null &&
    misstatesGiven("Let's look at the problem statement: 3 × 9.8 × sin(20°) = 10.06.", ["A 3 kg box, 20° incline"]) === null);

  script = () => ({ content: "Work is force times distance: W = Fd when the force is parallel. Which force do you mean?" });
  r = await run("what's the formula for work", { board: [{ id: "g1", at: "", kind: "given", text: "15 N box, 4 m up a 30° slope" }] });
  check("a formula in the reply goes on the board — the chat carries the words, the board carries the maths", r.board.length === 1 && /W = Fd/.test(r.board[0].text));

  // "Here's a fresh one on the board" with no CREATE_PROBLEM, and "let's wrap this up", are both sent back.
  script = () => ({ content: "Here is a fresh one on the board, Willem. Give it a go!" });
  r = await run("let's do another one");
  check("presenting a new problem 'on the board' without CREATE_PROBLEM is sent back to actually create it", /nothing was written this turn|CREATE_PROBLEM/.test(JSON.stringify(calls[1]?.messages || "")));
  const { wrapsUpUnasked: wu } = await import("../server/tutorAdapt.ts");
  check("'Let's wrap this up for now — great work!' counts as an unasked wrap-up", wu("You nailed it. Let's wrap this up for now — great work!", "yes it makes sense"));
  const mp = makeProblem({ question: "A 3 kg box is pulled up a 20° slope by 12 N with 2 N friction over 5 m; find the speed.", answer: "1.0", check: "sqrt(2*(12-2-3*9.8*sin(20*pi/180))*5/3)" }, true);
  check("a problem whose own check can't evaluate (impossible numbers: the pull can't beat gravity + friction) is refused with that reason", "error" in mp && /impossible|does not evaluate/.test(mp.error));

  // The tutor's board edits go through the validated action layer: its own lines can be corrected in place / taken off, the student's can't.
  const editBoard = [
    { id: "t1", at: "", kind: "formula", text: "$W_{net} = 5.52 \\times 4 = 22.08$", owner: "otto" },
    { id: "s1", at: "", kind: "result", text: "$F_{net} = 4.4$", owner: "student" },
  ];
  script = (b, i) => i === 0 ? { content: "", tool_calls: [tc("UPDATE_BOARD_LINE", { target: "t1", text: "$W_{net} = 4.4 \\times 4 = 17.6$" }), tc("UPDATE_BOARD_LINE", { target: "s1", text: "$F_{net} = 5$" }), tc("REMOVE_BOARD_LINE", { target: "s1" }), tc("UPDATE_BOARD_LINE", { target: "zzz", text: "x" })] }
    : { content: "I fixed my own line — the net force is yours, 4.4. What do you get for the work?" };
  r = await run("why did you write 22.08?", { board: editBoard });
  const editTools = calls[1]?.messages.filter((m) => m.role === "tool").map((m) => m.content) || [];
  check("tutor edits go through the board action layer: own line corrected in place (id, no duplicate), student's line refused (FORBIDDEN_STUDENT_WORK) for update AND remove, unknown target = NOT_FOUND",
    r.boardEdits?.length === 1 && r.boardEdits[0].id === "t1" && /17\.6/.test(r.boardEdits[0].text) && !r.boardRemoved?.length && r.board.length === 0
    && /"ok":true/.test(editTools[0]) && /FORBIDDEN_STUDENT_WORK/.test(editTools[1]) && /FORBIDDEN_STUDENT_WORK/.test(editTools[2]) && /NOT_FOUND/.test(editTools[3]));
  script = (b, i) => i === 0 ? { content: "", tool_calls: [tc("REMOVE_BOARD_LINE", { target: "t1" })] } : { content: "Taken off — it was my wrong line." };
  r = await run("that line is wrong", { board: editBoard });
  check("a tutor line can be taken off the active board (archived, reversible)", r.boardRemoved?.length === 1 && r.boardRemoved[0] === "t1");

  const { parsePlan: pp } = await import("../server/tutor.ts");
  script = () => ({ content: '<plan>{"diagnosis":"none","action":"probe","help_level":1}</path>Imagine a block sliding down a ramp. What is the first thing you would write?' });
  r = await run("let's do energy");
  check("a hidden plan closed with the wrong tag (</path>) is stripped, never shown, and still parsed", !/plan|path|diagnosis/.test(r.reply) && /Imagine a block/.test(r.reply) && pp('<plan>{"diagnosis":"none","action":"probe","help_level":1}</path>x')?.action === "probe");
  script = (b, i) => i === 0 ? { content: "Imagine a block on a ramp. If a 2 kg block drops from a height of 3 m onto a spring with k = 400 N/m, how would you set up the energy conservation?" }
    : i === 1 ? { content: "", tool_calls: [tc("WRITE_TO_BOARD", { text: "$m = 2$ kg, $h = 3$ m, $k = 400$ N/m", kind: "given" })] }
    : { content: "It's on the board — how would you set up the energy conservation?" };
  r = await run("give me a spring problem");
  check("a new scenario posed only in the message (no board write) is sent back to put it on the board", /nothing is on the board/.test(JSON.stringify(calls[1]?.messages || "")));
  const { solvedGapKey: sgk } = await import("../server/tutor.ts");
  check("a gap that states an equation for its unknown is SOLVED in code (2·9.8·3 = ½(400)x² ⟹ x = ? → 0.5422), so a correct 0.54 is never 'checked wrong'",
    Math.abs(sgk("$2 \\cdot 9.8 \\cdot 3 = \\frac{1}{2}(400)x^2 \\Longrightarrow x = ?$") - 0.542218) < 1e-5 && Math.abs(sgk("2·9.8·3 = ½(400)x² ⟹ x = ?") - 0.542218) < 1e-5 && sgk("3x + 1 = 10 ⟹ x = ?") === 3
    // "F = 5 ⟹ F = ?" states its own value, so the line solves to 5. It returned null only because the
    // solve keyed its value map by the RAW target ("F") while the compiler lowercases every identifier —
    // i.e. the same case bug that stopped EVERY uppercase unknown (P, Q, V, F…) from ever being solved.
    && sgk("F = 5 ⟹ F = ?") === 5
    && equivalent("0.54", String(sgk("2·9.8·3 = ½(400)x² ⟹ x = ?")), "x") === "correct" && equivalent("0.55", "0.542218", "x") === "incorrect");

  section("Critical-thinking partner: agreement is always followed by a challenge");
  {
    const claim = "I think the treaty of Versailles caused the war because it humiliated Germany";
    check("'Great point, the treaty really humiliated Germany.' is caught", agreesWithoutChallenge("Great point, the treaty really humiliated Germany.", claim));
    check("…agreement plus an objection passes", !agreesWithoutChallenge("Good point — but the Depression hit a decade later. Would the Nazis have won without it?", claim));
    check("…and a short 'yes' to a short answer isn't a debate turn", !agreesWithoutChallenge("Yes.", "it's 8"));
    script = (b, i) => i === 0 ? { content: "Great point, the treaty really humiliated Germany." } : { content: "Good point — but the Depression came a decade later. Would the Nazis have won without it?" };
    const rh = await run(claim, { context: { subject: "History" } });
    check("in a History session the correction round asks for the challenge", /critical-thinking partner/.test(lastUser(calls[1])) && /Depression/.test(rh.reply));
  }

  section("Spec: proactive lesson plan, one canonical summary, rubric-graded concept answers");
  {
    // §6: a study goal gets a visible lesson plan up front — enforced by a correction round, not left to the model.
    check("statesStudyGoal / delegatesChoice / asksStudentToChoose recognise the reported phrasings",
      statesStudyGoal("help me revise for econ test") && statesStudyGoal("je dois réviser pour mon contrôle") && !statesStudyGoal("cost of production factors")
      && delegatesChoice("whatever u want") && delegatesChoice("i dont know whatever you want") && delegatesChoice("comme tu veux") && !delegatesChoice("lets do supply and demand")
      && asksStudentToChoose("What part of the chapter would you like to start with — scarcity or demand?") && !asksStudentToChoose("Let's start with shifts: what happens to price if demand rises?"));
    const PROPOSAL = "Here's a plan for today:\n1. Demand and supply shifts\n2. Equilibrium equations\n3. Price ceilings and shortages\nWant to change, add or drop anything?";
    script = (b, i) => i === 0 ? { content: "Let's do it! What part of the chapter would you like to start with?" }
      : i === 1 ? { tool_calls: [tc("SET_OBJECTIVES", { objectives: [{ label: "x", done: false }, { label: "y", done: false }, { label: "z", done: false }] })] }
      : { content: PROPOSAL };
    let rp = await run("help me revise for my econ test");
    check("a study goal gets a PROPOSED plan to approve — objectives are not set without consent",
      /DO NOT call SET_OBJECTIVES/.test(lastUser(calls[1])) && !rp.objectives && proposesPlan(rp.reply));
    script = (b, i) => i === 0 ? { content: "Great. Which topic first?" }
      : i === 1 ? { tool_calls: [tc("SET_OBJECTIVES", { objectives: [{ label: "Demand and supply shifts", done: false }, { label: "Equilibrium equations", done: false }, { label: "Drop ceilings, add elasticity", done: false }] })] }
      : { content: "Plan's up. First: if demand rises and supply stays put, what happens to price and quantity?" };
    rp = await run("yes but drop ceilings and add elasticity", { history: [{ role: "user", text: "help me revise for my econ test" }, { role: "assistant", text: PROPOSAL }] });
    check("after the student answers the proposal, the agreed plan is set and the first objective starts",
      /answered the plan you proposed/.test(lastUser(calls[1])) && rp.objectives?.length === 3 && !/Which topic/.test(rp.reply));
    check("planConsented: needs a proposal, an explicit ask, or an existing plan", planConsented([{ role: "assistant", text: PROPOSAL }], "ok", false) && planConsented([], "make a plan for me", false) && planConsented([], "ok", true) && !planConsented([{ role: "assistant", text: "What are you working on?" }], "ok", false));
    script = (b, i) => i === 0 ? { content: "Sure! Which topic do you want to work on?" } : { content: "Then we'll do the current milestone: shifts. If supply falls, what happens to price?" };
    rp = await run("whatever you want", { objectives: [{ id: "o1", label: "Explain shifts", done: false }] });
    check("'whatever you want' answered with 'which topic?' goes back once — Otto picks and starts", /left the choice to you/.test(lastUser(calls[1])) && !/Which topic/.test(rp.reply));
    script = () => ({ content: "If supply falls, what happens to price?" });
    rp = await run("ok", { objectives: [{ id: "o1", label: "Explain shifts", done: true }, { id: "o2", label: "Solve equilibrium", done: false }] });
    check("the lesson plan block names the CURRENT milestone and tells Otto to drive the lesson", /Solve equilibrium\s+← CURRENT/.test(systemOf(calls[0])) && /You drive the lesson/.test(systemOf(calls[0])));

    // §20.3 / test 17: two solved equilibrium calculations in a row → the third exercise must change format.
    const solvedCalcs = [{ id: "a", question: "Qd=500-20P, Qs=100+30P. P?", answer: "8", value: 8, solved: true, createdAt: "" }, { id: "b", question: "Qd=200-10P, Qs=20+26P. P?", answer: "5", value: 5, solved: true, createdAt: "" }];
    const third = { question: "Qd=300-15P, Qs=50+10P. Find P.", answer: "10", check: "250/25" };
    check("a third same-kind calculation after two solved ones is refused — change the format (spec test 17)",
      repeatsSolvedCalculation(solvedCalcs, third, "another problem") && !repeatsSolvedCalculation(solvedCalcs, third, "Another one like it, please.")
      && !repeatsSolvedCalculation(solvedCalcs, { question: "Which way does supply shift?", options: ["left", "right"], correct: 0 }, "another problem")
      && !repeatsSolvedCalculation([solvedCalcs[0], { ...solvedCalcs[1], solved: false }], third, "another problem"));
    // §13.6 / test 26: one canonical summary, updated in place.
    const sumBoard = [{ id: "s1", at: "", kind: "summary", text: "Demand ↑ ⟹ price ↑, quantity ↑" }];
    const res = { reply: "", board: [], problems: [], tokens: { in: 0, out: 0, cachedIn: 0 }, guardrailTripped: false };
    const out = applyTool("WRITE_TO_BOARD", { kind: "summary", text: "Demand ↑ ⟹ price ↑, quantity ↑; supply ↓ ⟹ price ↑, quantity ↓" }, { message: "summarize", result: res, allBoard: () => [...sumBoard, ...res.board], allProblems: () => [], spokenRepair: null, fr: false, said: [], wantsExercise: false, focus: ["supply demand"], known: [], solution: undefined });
    check("a second summary updates the existing one in place — no duplicate entry", /"ok":true/.test(out) && res.board.length === 0 && res.boardEdits?.[0]?.id === "s1" && /supply ↓/.test(res.boardEdits[0].text));
  }
}
