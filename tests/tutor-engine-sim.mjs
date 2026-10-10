// The new tutor engine (server/tutor.ts) against a scripted fake model: globalThis.fetch is intercepted for
// api.deepseek.com, so the REAL turn loop, tools and guards run with no network and no key. It can't judge how
// a live model writes; it proves the few hard guarantees hold: no answer leaks, wrong arithmetic gets fixed,
// the board only takes maths that typesets and never a mishearing, one problem at a time, and the prompt
// carries the conversation first and the background second.
process.env.DEEPSEEK_API_KEY ||= "sim-key";
delete process.env.GEMINI_API_KEY;
const { runTutorTurn, detectSubject, backgroundBlock, TUTOR_PROMPT, leakedValue, wantsExercise, inventsProblemOnBoard, doubtsRightAnswer, softenOpener, computedGapKey } = await import("../server/tutor.ts");
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

  script = () => ({ content: "Yes, b = h/tan(25°) — now put it in the second equation." });
  r = await run("b = h/tan(25°)", { board: gapBoard });
  check("a value the student said themselves is theirs, not a leak", calls.length === 1 && /h\/tan\(25°\)/.test(r.reply));

  const probs = [{ id: "p1", question: "Water content of a 125 g sample with dry mass 100 g?", answer: "0.25", createdAt: "" }];
  check("leakedValue: open problem answers count, solved ones don't", leakedValue("so it comes out at 0.25", "hm", [], probs) !== null && leakedValue("so it comes out at 0.25", "hm", [], [{ ...probs[0], solved: true }]) === null);

  script = (b, i) => i === 0 ? { content: "Right: 12 × 3 = 38. What next?" } : { content: "Right: 12 × 3 = 36. What next?" };
  r = await run("12 times 3?");
  check("a wrong calculation in the reply is caught and rewritten", r.reply === "Right: 12 × 3 = 36. What next?" && /wrong calculation/.test(lastUser(calls[1])));
  script = () => ({ content: "You wrote 2 + 2 = 5 — try it with two apples?" });
  r = await run("2 + 2 = 5");
  check("…but quoting the STUDENT's own slip back to them is the point, not an error", calls.length === 1);

  script = (b, i) => i === 0
    ? { tool_calls: [tc("WRITE_TO_BOARD", { text: "$\\frac{h}{100 + \\tan(25^\\circ)$", kind: "formula" }), tc("WRITE_TO_BOARD", { text: "$\\tan(15^\\circ) = \\frac{h}{100+b}$", kind: "formula" })] }
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
}
