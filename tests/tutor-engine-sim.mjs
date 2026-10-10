// The new tutor engine (server/tutor.ts) against a scripted fake model: globalThis.fetch is intercepted for
// api.deepseek.com, so the REAL turn loop, tools and guards run with no network and no key. It can't judge how
// a live model writes; it proves the few hard guarantees hold: no answer leaks, wrong arithmetic gets fixed,
// the board only takes maths that typesets and never a mishearing, one problem at a time, and the prompt
// carries the conversation first and the background second.
process.env.DEEPSEEK_API_KEY ||= "sim-key";
delete process.env.GEMINI_API_KEY;
const { runTutorTurn, detectSubject, backgroundBlock, TUTOR_PROMPT, leakedValue, wantsExercise, inventsProblemOnBoard } = await import("../server/tutor.ts");

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
  r = await run("so what now", { board: gapBoard.slice(0, 1) });
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
  check("asked for a problem but the draft only TALKS about one → one round to create it", r.problems.length === 1 && /They asked for an exercise/.test(lastUser(calls[1])));

  script = (b, i) => i === 0 ? { tool_calls: [tc("WRITE_TO_BOARD", { text: "A 2 kg block slides 5 m down a 30° ramp", kind: "given" })] } : { content: "What do you want to work on?" };
  r = await run("I want to understand energy");
  check("Otto can't invent a problem as board givens (numbers nobody gave)", r.board.length === 0);
  script = (b, i) => i === 0 ? { tool_calls: [tc("WRITE_TO_BOARD", { text: carGiven, kind: "given" })] } : { content: "What's being asked?" };
  r = await run("A car of mass 1000 kg climbs a hill of slope 10 degrees at 15 m/s. Find the power needed.");
  check("…but the student's own problem goes up as givens", r.board.length === 1);
  check("wantsExercise / inventsProblemOnBoard", wantsExercise("give me another problem") && wantsExercise("interroge-moi") && wantsExercise("quiz me") && !wantsExercise("I'm stuck on this one") &&
    inventsProblemOnBoard("A 2 kg block on a 30° ramp", ["help with ramps"]) && !inventsProblemOnBoard("A 2 kg block on a 30° ramp", ["a 2 kg block on a 30 degree ramp"]) && !inventsProblemOnBoard("$E = mgh$", []));
}
