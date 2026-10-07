import { readFileSync } from "node:fs";
// Tutor pipeline simulation — runs the REAL chatAboutTask (tool loop, guards, nudges, board writes) against a
// scripted fake model endpoint (globalThis.fetch is intercepted for api.deepseek.com). It cannot judge how a
// live model WRITES, but it proves the machinery around it does what the tutor promises: never lets a stated
// answer through, hands the thinking back, writes reasoning to the board, rejects bad/leaky tool calls and
// keeps replies short. No network, no key needed.
process.env.DEEPSEEK_API_KEY ||= "sim-key";
const { chatAboutTask, summarizeCoursework, makeGeometryEntry, makeProblem, isDuplicateProblem, isDuplicateBoardEntry, isDuplicateDiagram, wantsArtifactTools } = await import("../server/claude.ts");
const { buildGeometry } = await import("../shared/geometry.ts");
const { autoMathLine } = await import("../shared/mathText.ts");
const P = await import("../server/tutorPolicy.ts");

let script = () => ({ content: "" });
let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("api.deepseek.com")) return realFetch(url, init);
  const body = JSON.parse(init.body);
  calls.push(body);
  const out = script(body, calls.length - 1) || { content: "" };
  const message = { role: "assistant", content: out.content ?? "", ...(out.tool_calls ? { tool_calls: out.tool_calls.map((t, i) => ({ id: `call_${calls.length}_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}) };
  return new Response(JSON.stringify({ id: "sim", object: "chat.completion", model: "sim", choices: [{ index: 0, message, finish_reason: out.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 120, completion_tokens: 30 } }), { status: 200, headers: { "content-type": "application/json" } });
};

const task = { title: "Math session", why: "tutoring", source: "freestudy", sourceSubject: "Math" };
const problem = { id: "p1", question: "Solve x² − 5x + 6 = 0", answer: "x = 2 or x = 3", why: "factors (x−2)(x−3)", createdAt: new Date().toISOString() };
const run = async (message, o = {}) => { calls = []; const res = await chatAboutTask(task, o.history || [], message, undefined, undefined, { primer: true, canvasMode: true, currentProblems: o.problems || [], currentBoard: o.board || [], ...(o.opts || {}) }); return { ...res, boardAll: res.board, board: res.board.filter((e) => e.kind !== "question") }; };
const tc = (name, args) => ({ name, args });
const lastUserText = (body) => String([...body.messages].reverse().find((m) => m.role === "user")?.content || "");

export async function runTutorSim(check, section) {
  section("Tutor simulation — Socratic, never gives the answer, board as a companion (real pipeline, scripted model)");

  // 1. A model that blurts the answer is caught and replaced by a question.
  script = () => ({ content: "The answer is x = 2 or x = 3. You just factor it." });
  let r = await run("what's the answer?", { problems: [problem], history: [{ role: "user", text: "hi" }, { role: "assistant", text: "Hey! What are you on?" }] });
  check("a reply stating the problem's answer is blocked and replaced by a question", r.guardrailTripped && !/x = 2/.test(r.reply) && /\?\s*$/.test(r.reply));

  // 2. A Socratic reply passes through untouched.
  script = () => ({ content: "Mm, close. What two numbers multiply to 6 and add to −5?" });
  r = await run("is it x−5?", { problems: [problem], history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("a Socratic question reply is kept as is", r.reply === "Mm, close. What two numbers multiply to 6 and add to −5?" && !r.guardrailTripped);

  // 3. Over-long drafts are tightened locally, closing question kept, with NO extra model call.
  const long = "So here is the thing about quadratics. " + "They are everywhere in physics and economics and a lot more besides which is honestly a lot to take in. ".repeat(6) + "Which two numbers multiply to 6 and add to −5?";
  script = () => ({ content: long });
  r = await run("explain quadratics", { history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("a long draft is cut to a few sentences and keeps its closing question (one model call)", r.reply.split(/\s+/).length <= 75 && /Which two numbers multiply to 6 and add to −5\?$/.test(r.reply) && calls.length === 1);

  // 4. The tutor writes reasoning on the board via the tool, then replies.
  script = (b, i) => i === 0
    ? { content: "", tool_calls: [tc("WRITE_TO_BOARD", { text: "Factor: two numbers with product 6 and sum −5 → −2, −3", kind: "summary" })] }
    : { content: "Nice. So what does each factor equal when the product is zero?" };
  r = await run("(x−2)(x−3)=0", { problems: [problem], history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("a WRITE_TO_BOARD reasoning entry lands on the board and the reply is a question", r.board.length === 1 && r.board[0].kind === "summary" && /Factor/.test(r.board[0].text) && /\?$/.test(r.reply));

  // 5. A board entry that states the answer is rejected.
  script = (b, i) => i === 0
    ? { content: "", tool_calls: [tc("WRITE_TO_BOARD", { text: "Answer: x = 2 or x = 3", kind: "summary" })] }
    : { content: "What do you get if you set each factor to zero?" };
  r = await run("help", { problems: [problem], history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("a board write that states the problem's answer is rejected (board stays empty)", r.board.length === 0 && calls.length >= 2 && /REJECTED/.test(JSON.stringify(calls[1].messages)));

  // 6. Reasoning nudge: a substantive step with NO board write triggers one corrective round.
  script = (b, i) => {
    if (i === 0) return { content: "Good. What next?" };
    if (/1-3 short WRITE_TO_BOARD calls/.test(lastUserText(b)) && !b.messages.some((m) => m.role === "tool")) return { content: "", tool_calls: [tc("WRITE_TO_BOARD", { text: "Move 1: factor the quadratic; why: products of roots give the constant term", kind: "summary" })] };
    return { content: "Good. What does each factor give you?" };
  };
  r = await run("x² − 5x + 6 = (x−2)(x−3)", { history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("student step + no board write → one corrective round puts the reasoning on the board", r.board.length === 1 && r.board[0].kind === "summary" && calls.some((b) => /1-3 short WRITE_TO_BOARD calls/.test(lastUserText(b))));
  check("…and the entry is Otto's own reasoning, not a copy of the student's message", !/\(x−2\)\(x−3\)$/.test(r.board[0]?.text || "") && r.board[0].text !== "x² − 5x + 6 = (x−2)(x−3)");

  // 7. No nudge for chatter / first message / questions.
  for (const [msg, hist] of [["ok", [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }]], ["what is a root?", [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }]], ["x = 3 so 2x = 6", []]]) {
    script = () => ({ content: "Okay. What next?" });
    r = await run(msg, { history: hist });
    check(`no corrective board round for "${msg}"${hist.length ? "" : " (first message)"}`, !calls.some((b) => /1-3 short WRITE_TO_BOARD calls/.test(lastUserText(b))) && r.board.length === 0);
  }

  // 8. Graph tool: valid plot lands on the board; a bad expression is explained back to the model.
  script = (b, i) => i === 0
    ? { content: "", tool_calls: [tc("GRAPH_ON_BOARD", { caption: "Drag a — what happens to the opening?", xmin: -5, xmax: 5, fns: [{ expr: "a*x^2" }], params: [{ name: "a", min: -3, max: 3, value: 1 }] })] }
    : { content: "Slide a. What changes about the opening?" };
  r = await run("show me a parabola", { history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("GRAPH_ON_BOARD puts a live slider graph on the board", r.board.length === 1 && r.board[0].kind === "graph" && r.board[0].graph.params?.[0]?.name === "a");
  script = (b, i) => i === 0
    ? { content: "", tool_calls: [tc("GRAPH_ON_BOARD", { caption: "bad", xmin: -5, xmax: 5, fns: [{ expr: "q*x" }] })] }
    : { content: "Let me try that again. What do you notice?" };
  r = await run("graph it", { history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("a bad graph expression is sent back to the model as a readable error (nothing broken on the board)", r.board.length === 0 && /can't plot[\s\S]{0,12}q\*x/.test(JSON.stringify(calls[1].messages)) && /unknown name/.test(JSON.stringify(calls[1].messages)));

  // 9. Memory: a long thread sends a 24-message window + a digest of what came before.
  const hist = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: i % 2 ? `Otto turn ${i}. More.` : `student step ${i}` }));
  script = () => ({ content: "Right. What's next?" });
  r = await run("and then?", { history: hist });
  const sent = calls[0].messages;
  check("long thread: older turns are condensed into an 'EARLIER IN THIS SESSION' digest", sent.some((m) => m.role === "system" && /^EARLIER IN THIS SESSION/.test(m.content)) && sent.filter((m) => m.role !== "system").length === 24 + 1);

  // 10. Persona + board context the model is actually given.
  const sys = String(calls[0].messages[0].content);
  check("the system prompt carries the Socratic/board contract the tutor is held to", /SOUND LIKE A PERSON/.test(sys) && /THE BOARD IS THE WORKING/.test(sys) && /EXERCISE RESULTS ARRIVE AS/.test(sys) && /ASK what they want to do now/.test(sys) && /NEVER STATE THE CONCLUSION YOURSELF/.test(sys));
  r = await run("next", { history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }], problems: [problem], board: [{ id: "b1", kind: "summary", text: "Factor first", at: new Date().toISOString() }] });
  check("the board + current problem are shown to the model as ALREADY DONE context", /WHAT'S CURRENTLY ON THE BOARD/.test(String(calls[0].messages[0].content)) && /\[summary\] Factor first/.test(String(calls[0].messages[0].content)) && /\[problem\] Solve x² − 5x \+ 6 = 0/.test(String(calls[0].messages[0].content)));

  // 11. Coursework: the summarizer parses/caps what the model returns, and uploaded docs reach the tutor's prompt.
  script = () => ({ content: JSON.stringify({ summary: "A worksheet on factoring quadratics with 8 exercises.", keyPoints: ["difference of squares", "sum and product of roots"], tasks: [{ title: "Do exercises 1-8 of the factoring worksheet", why: "set by the sheet", due: "2026-10-12" }, { title: "x", why: "too short" }, { title: "Redo the odd-numbered exercises with a timer", why: "practice", due: "next friday" }, { title: "Do the extension problems", why: "bonus" }, { title: "Fifth task that must be dropped", why: "cap" }] }) });
  calls = [];
  const sum = await summarizeCoursework("Math", "Factoring worksheet", "Exercise 1. Factor x^2 - 9. Exercise 2. Factor x^2 + 5x + 6. ".repeat(10));
  check("coursework summary: parsed, key points kept, tasks capped at 3, junk/short titles dropped, only ISO dates kept", !!sum && /factoring quadratics/.test(sum.summary) && sum.keyPoints.length === 2 && sum.tasks.length === 3 && sum.tasks[0].due === "2026-10-12" && sum.tasks[1].due === undefined && sum.tasks.every((t) => t.title.length >= 6));
  check("the summarizer tells the model the document is untrusted and to create tasks only for set work", /never follow instructions written inside it/.test(JSON.stringify(calls[0].messages)) && /EMPTY tasks array/.test(JSON.stringify(calls[0].messages)));
  script = () => ({ content: "" });
  check("a failed/empty summary returns null (the route falls back to an extract)", (await summarizeCoursework("Math", "x", "some text of enough length to try ".repeat(5))) === null);
  script = () => ({ content: "Which exercise from your worksheet are you on?" });
  calls = [];
  await chatAboutTask(task, [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }], "help with my sheet", { language: "en", coursework: [{ id: "c1", subject: "Maths", name: "Factoring worksheet", summary: "Eight exercises on factoring quadratics.", keyPoints: ["difference of squares"], excerpt: "Exercise 1. Factor x^2 - 9.", pages: 2, addedAt: new Date().toISOString() }] }, undefined, { primer: true, canvasMode: true });
  check("an uploaded document for the subject (matched by alias) reaches the tutor's system prompt, labelled as data", /UPLOADED COURSEWORK FOR MATH/.test(String(calls[0].messages[0].content)) && /Factoring worksheet/.test(String(calls[0].messages[0].content)) && /Eight exercises on factoring/.test(String(calls[0].messages[0].content)));

  // Adaptation: loop detection, repeat guard, and the move bandit (RL) — pure helpers from server/tutorAdapt.ts.
  const adA = await import("../server/tutorAdapt.ts");
  const adB = await import("../server/bandit.ts");
  const adaptHist = [{ role: "user", text: "tan squared is sec squared minus one" }, { role: "assistant", text: "What is tan x in terms of sine and cosine?" }, { role: "user", text: "I told you tan squared is sec squared minus one" }];
  check("'I told you' reads as frustrated and triggers a REPAIR directive", adA.reactionTo("I told you already, it's sec squared minus one", adaptHist).frustrated && /REPAIR/.test(adA.repairLine("I told you already", adaptHist)));
  check("a normal attempt does not trigger REPAIR", adA.repairLine("so the bracket is sec x minus 3", adaptHist) === "");
  check("saying the same thing again is detected as repeated", adA.reactionTo("tan squared equals sec squared minus one", adaptHist).repeated);
  check("near-copy replies are flagged as a loop / repeat", adA.repeatsRecentReply("What is tan x in terms of sine and cosine?", adaptHist) && !adA.repeatsRecentReply("Try drawing the right triangle with angle x.", adaptHist));
  let adst = {}, adkey = "move|Math|stuck";
  for (let n = 0; n < 40; n++) adst = adB.updatePosterior(adst, adkey, "visual", 1), adst = adB.updatePosterior(adst, adkey, "probe", 0);
  let adwins = 0; for (let n = 0; n < 50; n++) if (adB.chooseArm(adA.TUTOR_MOVE_ARMS, adst, adkey).arm.id === "visual") adwins++;
  check("the move bandit learns: the move that keeps working is served most", adwins > 35);
  const adplan1 = adA.planMove({ userKey: "u:t", message: "ok", history: [], state: adst, contextKey: adkey, update: adB.updatePosterior });
  const adplan2 = adA.planMove({ userKey: "u:t", message: "I told you, that's not working", history: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }], state: adst, contextKey: adkey, update: adB.updatePosterior });
  check("a move that just failed is never served twice in a row and its failure is scored", adplan2.arm !== adplan1.arm && adplan2.scoredPrev?.arm === adplan1.arm && adplan2.scoredPrev.reward === 0);

  // Geometry figures: the model states the maths, the compiler does the drawing (shared/geometry.ts).
  const geo = buildGeometry({ triangle: { names: ["A", "B", "C"], sides: [3, 4, 5] }, angles: [{ at: "C", from: "A", to: "B", right: true }] });
  const lines = (geo.ops || []).filter((o) => o.op === "line");
  const L2 = (o) => Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
  const [AB, BC, CA] = lines;
  check("a 3-4-5 triangle is drawn with true proportions (sides 5:3:4) and closes", !geo.error && Math.abs(L2(AB) / L2(BC) - 5 / 3) < 0.02 && Math.abs(L2(CA) / L2(BC) - 4 / 3) < 0.02 && Math.hypot(AB.x2 - BC.x1, AB.y2 - BC.y1) < 0.2 && Math.hypot(BC.x2 - CA.x1, BC.y2 - CA.y1) < 0.2);
  check("the right angle at C really is 90° and gets a square mark; side lengths + A, B, C are labelled", Math.abs(((BC.x2 - BC.x1) * (CA.x2 - CA.x1) + (BC.y2 - BC.y1) * (CA.y2 - CA.y1))) < 0.02 * L2(BC) * L2(CA) && geo.ops.some((o) => o.op === "polyline" && o.points.length === 3) && ["3", "4", "5", "A", "B", "C"].every((t) => geo.ops.some((o) => o.op === "label" && o.text === t)));
  check("every op stays inside the 800×600 board", geo.ops.every((o) => ["x", "x1", "x2", "cx"].every((k) => !(k in o) || (o[k] >= 0 && o[k] <= 800)) && ["y", "y1", "y2", "cy"].every((k) => !(k in o) || (o[k] >= 0 && o[k] <= 600))));
  const alt = buildGeometry({ triangle: { names: ["A", "B", "C"], sides: [7, 6, 5] }, derive: [{ name: "H", kind: "foot", from: "A", onto: ["B", "C"] }], segments: [{ from: "A", to: "H", dashed: true }], angles: [{ at: "H", from: "A", to: "B", right: true }] });
  const ah = alt.ops.filter((o) => o.op === "line" && o.dashed)[0];
  const bc = alt.ops.filter((o) => o.op === "line")[1];
  check("an altitude's foot is exactly perpendicular to its base and the line is dashed", !alt.error && !!ah && Math.abs((ah.x2 - ah.x1) * (bc.x2 - bc.x1) + (ah.y2 - ah.y1) * (bc.y2 - bc.y1)) < 0.01 * L2(ah) * L2(bc));
  const sec = buildGeometry({ points: { O: [0, 0] }, derive: [{ name: "A", kind: "polar", from: "O", dist: 2, deg: 0 }, { name: "B", kind: "polar", from: "O", dist: 2, deg: 150 }], segments: ["OA", "OB"], arcs: [{ center: "O", r: 2, from: 0, to: 150, label: "5π/6" }] });
  check("a sector compiles to two radii plus a counter-clockwise arc", !sec.error && sec.ops.filter((o) => o.op === "line").length === 2 && sec.ops.some((o) => o.op === "arc" && o.a1 < o.a0));
  const circ = buildGeometry({ points: { O1: [0, 0], O2: [25, 0] }, circles: [{ center: "O1", r: 15 }, { center: "O2", r: 10 }] });
  const cs = circ.ops.filter((o) => o.op === "circle" && o.r > 4);
  check("two touching circles keep their radius ratio and touch", !circ.error && Math.abs(cs[0].r / cs[1].r - 1.5) < 0.01 && Math.abs(Math.hypot(cs[1].cx - cs[0].cx, cs[1].cy - cs[0].cy) - (cs[0].r + cs[1].r)) < 0.5);
  check("impossible or undefined input gives a model-readable error, not a broken figure", /can't form a triangle/.test(buildGeometry({ triangle: { names: ["A", "B", "C"], sides: [1, 1, 5] } }).error) && /defined point/.test(buildGeometry({ points: { A: [0, 0] }, segments: ["AZ"] }).error || "") && "error" in makeGeometryEntry({ points: { A: [0, 0] } }));
  // end to end: the tool is offered and a call lands on the board as a diagram entry
  script = (b, i) => i === 0
    ? { content: "", tool_calls: [tc("GEOMETRY_ON_BOARD", { caption: "Triangle ABC", triangle: { names: ["A", "B", "C"], sides: [3, 4, 5] }, angles: [{ at: "C", from: "A", to: "B", right: true }] })] }
    : { content: "There's the triangle. Which side is the hypotenuse?" };
  r = await run("help me with a right triangle", { history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("GEOMETRY_ON_BOARD is offered to the tutor and its figure lands on the board", calls[0].tools.some((x) => x.function?.name === "GEOMETRY_ON_BOARD") && r.board.length === 1 && r.board[0].kind === "diagram" && r.board[0].diagram.length > 8);

  // Human tutor pass: gentle openers, dictated-maths hint, the session's start survives a long thread.
  check("a harsh opener is softened (Careful —, No,, Wrong.)", /^Hm, let's check that/.test(adA.softenOpener("Careful — 1/cos x is sec x. What now?")) && !/^Wrong/i.test(adA.softenOpener("Wrong. Try again?")) && adA.softenOpener("Nice — what next?") === "Nice — what next?");
  const sp = adA.spokenMathHint("three times one over cotan squared minus 3 over cosine equals 8 sec plus 25");
  check("dictated maths gets a literal transcription plus a grouping warning; plain text gets none", /cot ²/.test(sp) && /GROUPING/.test(sp) && adA.spokenMathHint("what is the derivative of x squared") === "");
  const longHist = []; for (let n = 0; n < 40; n++) longHist.push({ role: n % 2 ? "assistant" : "user", text: n % 2 ? "ok, go on" : "step " + n });
  script = () => ({ content: "Which factor first?" });
  await run("next?", { history: longHist, opts: { opening: [{ role: "user", text: "Solve 3(1/cot^2 x - 3/cos x) = 8 sec x + 25 for the form (a sec x + b)(sec x + c)" }] } });
  check("the session's opening statement is pinned verbatim in the prompt even when the thread is long", JSON.stringify(calls[0].messages).includes("HOW THIS SESSION BEGAN") && JSON.stringify(calls[0].messages).includes("8 sec x + 25"));
  script = () => ({ content: "Careful — that isn't it. What is 1/cos x?" });
  r = await run("is it 3 sec x", { history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("end to end: a harsh draft reaches the student softened", /^Hm, let's check that/.test(r.reply));

  script = () => ({ content: "Mm. What happens to the −3 when you distribute it?" });
  await run("so it is 3 sec x", { history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  const sysTxt = String(calls[0].messages[0].content);
  check("the tutor is told to be critical-but-kind: verify every step, never wave a wrong step through, justify, never erase the board", /CRITICAL, KINDLY/.test(sysTxt) && /never wave it through/.test(sysTxt) && /ever erased/.test(sysTxt));

  // Exercises are only for ONE-answer questions.
  check("a short single-answer exercise is accepted", !("error" in makeProblem({ question: "Simplify $\\cos^2\\theta(1+\\tan^2\\theta)$ to a single number.", answer: "1" })) && !("error" in makeProblem({ question: "Solve 2x + 3 = 11.", answer: "x = 4" })));
  check("open-ended asks (explain / why / prove / compare) are rejected as exercises", ["Explain why the sum of angles is 180°.", "Prove that sin²x + cos²x = 1.", "Why does the graph open upward?", "Compare mitosis and meiosis.", "Explique pourquoi x² ≥ 0."].every((q) => /open-ended/.test(makeProblem({ question: q, answer: "1" }).error || "")));
  check("prose answers and multi-part prompts are rejected; MCQ stays allowed", /ONE short checkable answer/.test(makeProblem({ question: "What happens to the force?", answer: "it doubles because the mass doubles" }).error || "") && /multi-part/.test(makeProblem({ question: "(a) Find x. (b) Find y.", answer: "3" }).error || "") && !("error" in makeProblem({ question: "Why is the sky blue?", options: ["Rayleigh scattering", "Reflection of the sea"], correct: 0 })));

  // The board must never answer the question Otto is asking.
  const unitTable = { text: "90°: (0, 1)\n180°: (-1, 0)\n270°: (0, -1)\n<- x = cos(a), y = sin(a)", kind: "note" };
  check("a board table that already shows the asked value is detected (the 270° case)", adA.boardStatesAskedValue("So what's cos(270°) and sin(270°) down there?", [unitTable]).length === 1);
  check("a table that leaves the asked value as ? or shows only OTHER cases is fine", adA.boardStatesAskedValue("So what's cos(270°) and sin(270°)?", [{ text: "90°: (0, 1)\n180°: (-1, 0)\n270°: ?" }]).length === 0 && adA.boardStatesAskedValue("So what's cos(270°)?", [{ text: "90°: (0, 1)\n180°: (-1, 0)" }]).length === 0 && adA.boardStatesAskedValue("What's the next step?", [unitTable]).length === 0);
  check("a worked arithmetic line that states the asked product is detected", adA.boardStatesAskedValue("Now what is 7 × 8?", [{ text: "7 × 8 = 56" }]).length === 1);
  // end to end: the leaking entry is pulled, Otto redraws it with a blank, the student only ever sees the fixed one
  script = (b, i) => i === 0
    ? { content: "", tool_calls: [tc("WRITE_TO_BOARD", unitTable)] }
    : i === 1 ? { content: "Nailed it. So what's cos(270°) and sin(270°) down there?" }
    : i === 2 ? { content: "", tool_calls: [tc("WRITE_TO_BOARD", { text: "90°: (0, 1)\n180°: (-1, 0)\n270°: ?\n<- x = cos(a), y = sin(a)", kind: "note" })] }
    : { content: "Nailed it. So what's cos(270°) and sin(270°) down there?" };
  r = await run("180 is (-1, 0)", { history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("end to end: the self-answering table never reaches the student; the redrawn one with '?' does", r.board.length === 1 && /270°: \?/.test(r.board[0].text) && !/270°: \(0/.test(r.board[0].text));

  // Socratic scaffolding, questioning, board repeats.
  const stuck1 = adA.scaffoldLine("I don't know", [{ role: "user", text: "help" }, { role: "assistant", text: "What have you tried?" }]);
  const stuck3 = adA.scaffoldLine("idk", [{ role: "user", text: "idk" }, { role: "assistant", text: "a" }, { role: "user", text: "i'm lost" }, { role: "assistant", text: "b" }]);
  check("stuck turns climb the scaffold one rung at a time (pump → prompt → parallel example); a normal turn adds none", /LEVEL 1.*PUMP/s.test(stuck1) && /LEVEL 3.*PARTIAL EXAMPLE/s.test(stuck3) && adA.scaffoldLine("so x is 4", []) === "");
  const prog = [1, 2, 3].flatMap((n) => [{ role: "user", text: "step " + n + " x = " + n }, { role: "assistant", text: "ok " + n + "?" }]);
  check("every few turns of progress a critical-thinking probe is added (not while stuck, not on turn 1)", /CRITICAL-THINKING PROBE/.test(adA.probeLine("so the answer is x = 4", prog)) && adA.probeLine("idk", prog) === "" && adA.probeLine("x = 4", []) === "");
  check("a reply that asks nothing is flagged; a question or a thanks-goodbye is not", adA.needsQuestion("Good. The factors are (x−2)(x−3).", "x^2 - 5x + 6 = (x-2)(x-3)") && !adA.needsQuestion("Good. What does each factor equal?", "x^2") && !adA.needsQuestion("You're welcome!", "thanks"));
  script = (b, i) => i === 0 ? { content: "Right, the factoring is fine. Those give x = 2 and x = 3." } : { content: "Right, the factoring is fine. What does each factor equal when the product is zero?" };
  r = await run("(x-2)(x-3)=0", { history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("end to end: a statement-only reply gets one corrective round and ends on a guiding question", /\?$/.test(r.reply) && calls.length >= 2);
  check("a re-worded copy of an existing board line is a duplicate (the board no longer repeats itself)", isDuplicateBoardEntry([{ id: "1", text: "x = cos(a), y = sin(a) on the unit circle", kind: "note", at: "" }], { text: "On the unit circle: x = cos(a), y = sin(a)", kind: "note" }) && !isDuplicateBoardEntry([{ id: "1", text: "x = cos(a), y = sin(a)", kind: "note", at: "" }], { text: "tan(a) = sin(a)/cos(a)", kind: "note" }));
  const eqA = { id: "1", text: "The equation", kind: "diagram", at: "", diagram: [{ op: "equation", x: 1, y: 1, latex: "3(\\frac{1}{\\cot^2 x})" }] };
  check("the same figure/equation drawn twice is a duplicate; an added element makes it new", isDuplicateDiagram([eqA], { ...eqA, id: "2", diagram: [{ op: "equation", x: 9, y: 9, latex: "3 ( \\frac{1}{\\cot^2 x} )" }] }) && !isDuplicateDiagram([eqA], { ...eqA, id: "3", diagram: [...eqA.diagram, { op: "equation", x: 1, y: 80, latex: "= 8\\sec x" }] }));

  const exR = "[Exercise] I answered \"4\" — marked right (try #1).";
  check("milestone cheer: a streak of right exercises, or all objectives done; not on a plain turn or a single right answer", /MILESTONE/.test(adA.cheerLine(exR, [{ role: "user", text: exR }, { role: "assistant", text: "nice?" }])) && /every objective/.test(adA.cheerLine("ok", [], [{ done: true }, { done: true }])) && adA.cheerLine("x = 4", [], [{ done: true }, { done: false }]) === "" && adA.cheerLine(exR, []) === "");
  check("when stuck, the first rung normalises before shrinking the step", /NORMALISE/.test(adA.scaffoldLine("idk", [])));
  check("the persona has the warm-older-student voice and uses what it knows about the student", /WARM OLDER STUDENT/.test(String(calls[0].messages[0].content)) && /use what you know about them/.test(String(calls[0].messages[0].content)));

  check("plain-text maths in a trace line is wrapped as LaTeX (fractions, roots, greek, functions); prose and existing $…$ are left alone", autoMathLine("Evaluated: (√3/2)(√2/2) - (√2/2)(1/2)") === "Evaluated: $(\\frac{\\sqrt{3}}{2})(\\frac{\\sqrt{2}}{2}) - (\\frac{\\sqrt{2}}{2})(\\frac{1}{2})$" && /\$A = \\frac\{\\pi\}\{3\}\$, \$B = \\frac\{\\pi\}\{4\}\$/.test(autoMathLine("Substituted A = π/3, B = π/4")) && autoMathLine("Add up to 5π/12?") === "Add up to $\\frac{5\\pi}{12}$?" && autoMathLine("He should try again") === "He should try again" && autoMathLine("so $x^2$ is 4") === "so $x^2$ is 4" && /special-angle/.test(autoMathLine("mapped special-angle values for A = π/3")));
  check("an instruction ('Find … by writing π/12 as …') counts as asking: a board line that already shows the decomposition is detected", adA.boardStatesAskedValue("Find the exact value of sin(π/12) by writing π/12 as the difference of two special angles.", [{ text: "x", diagram: [{ latex: "\\sin(π/12) = \\sin(π/3 - π/4)" }] }]).length === 1 && adA.boardStatesAskedValue("Find the exact value of sin(π/12) by writing it as a difference of angles.", [{ text: "Target: sin(π/12) = ?" }]).length === 0);
  check("the persona makes the first move (the key idea / decomposition) the student's and asks for LaTeX on the board", /THE FIRST MOVE IS THEIRS/.test(String(calls[0].messages[0].content)) && /WRITE MATHS ON THE BOARD IN LaTeX/.test(String(calls[0].messages[0].content)));

  const loose = buildGeometry({ points: { A: [0, 0], B: [6, 0], C: [2, 4] } });
  check("points with no sides given are joined into a closed shape (never a figure of loose dots)", !loose.error && loose.ops.filter((o) => o.op === "line").length === 3 && buildGeometry({ points: { A: [0, 0], B: [3, 4] } }).ops.filter((o) => o.op === "line").length === 1);

  const said = ["can you do sin of five pi over twelve", "I think we split it into pi over four plus..."];
  check("a trace line with a step the student never said is flagged; their own (even spoken) steps and the given are fine", adA.traceAheadOfStudent("Splitting 5π/12 into sum of special angles: π/4 + π/6", ["find sin(5π/12)", "hmm no idea"], ["Find sin(5π/12)"]).join() === "π/4,π/6" && adA.traceAheadOfStudent("Split 5π/12 = π/4 + π/6", ["find sin(5π/12)", "pi over four plus pi over six"], []).length === 0 && adA.traceAheadOfStudent("Expanded sin(A - B)", [], []).length === 0 && adA.traceAheadOfStudent("sin(π/3) = √3/2", ["root 3 over 2 is sin of pi over 3"], []).length === 0);
  script = (b, i) => i === 0 ? { content: "", tool_calls: [tc("WRITE_TO_BOARD", { text: "Split 5π/12 into π/4 + π/6", kind: "summary" })] } : { content: "What do you get for sin of 5π/12 — which two angles would you split it into?" };
  r = await run("hmm I have no idea where to start with sin(5π/12)", { history: [{ role: "user", text: "find sin(5π/12)" }, { role: "assistant", text: "ok" }] });
  check("end to end: a tutor-authored step is refused on the board's trace", r.board.every((e) => e.kind !== "summary") && /REJECTED/.test(JSON.stringify(calls[1].messages)));
  check("a closing question is put on the board as a question entry; a generic 'does that make sense?' is not", adA.boardQuestionOf("Good. Which two special angles add up to 5π/12?") === "Which two special angles add up to 5π/12?" && adA.boardQuestionOf("Nice work. Does that make sense?") === "" && adA.boardQuestionOf("ok?") === "");
  script = () => ({ content: "Good start. Which two special angles add up to 5π/12?" });
  r = await run("so I need exact values", { history: [{ role: "user", text: "find sin(5π/12)" }, { role: "assistant", text: "ok" }] });
  check("end to end: the reply's guiding question lands on the board as kind 'question'", r.boardAll.some((e) => e.kind === "question" && /special angles add up/.test(e.text)));

  const sysT = String(calls[0].messages[0].content);
  check("the persona makes the board the student's paper for every subject (given / result / question / formulas / outlines / mnemonics)", /THE BOARD IS THEIR PAPER/.test(sysT) && /kind "result"/.test(sysT) && /kind "given"/.test(sysT) && /history\/economics\/literature/.test(sysT));
  // a student step with only an auto-added question on the board still gets the write-to-board nudge (summary + result)
  script = (b, i) => i === 0 ? { content: "Right, that's the sum formula. Which two special angles add up to 5π/12?" } : i === 1 ? { content: "", tool_calls: [tc("WRITE_TO_BOARD", { text: "Established: $\\sin(A+B)=\\sin A\\cos B+\\cos A\\sin B$", kind: "result" })] } : { content: "Right, that's the sum formula. Which two special angles add up to 5π/12?" };
  r = await run("so I use sin(A+B) = sin A cos B + cos A sin B", { history: [{ role: "user", text: "find sin(5π/12)" }, { role: "assistant", text: "ok" }] });
  check("a student step gets the nudge even though the question was auto-placed; a 'result' entry lands (kind result)", /kind \\\"result\\\"|kind \"result\"/.test(JSON.stringify(calls[1].messages)) || r.board.some((e) => e.kind === "result"));

  check("the board guidance is judgement, not a checklist (no forced entries, no repeats)", /GUIDE TO YOUR JUDGEMENT|a guide to your judgement/.test(String(calls[0].messages[0].content)) && /never write an entry just to have written one/.test(String(calls[0].messages[0].content)));
  script = () => ({ content: "Nice. Which factor first?" });
  r = await run("ok", { history: [{ role: "user", text: "solve x^2-5x+6" }, { role: "assistant", text: "ok" }], board: [{ id: "q", kind: "question", text: "Which two numbers multiply to 6 and add to −5?", at: "" }] });
  check("a new question card is not stacked on top of one the student is still working with", r.boardAll.every((e) => e.kind !== "question"));

  // One exercise at a time; never re-ask a question.
  check("a near-identical exercise is a duplicate (the 4× 'sin(5π/12) as a sum of special angles' problem)", isDuplicateProblem([{ id: "1", question: "Find the exact value of sin(5π/12) by writing 5π/12 as the sum of two special angles.", createdAt: "" }], { question: "Find the exact value of sin(5π/12) by writing 5π/12 = π/4 + π/6 as a sum of two special angles." }) && !isDuplicateProblem([{ id: "1", question: "Find sin(5π/12) as a sum of special angles.", createdAt: "" }], { question: "Given sin θ = 3/5 in the first quadrant, find sin(2θ)." }));
  check("'next', 'another one', 'skip', 'harder' explicitly ask to move on; ordinary answers don't", ["next one please", "Another one like it, please.", "can we skip this", "Give me a harder one.", "un autre exercice"].every(adA.asksToMoveOn) && !adA.asksToMoveOn("so it is root 6 over 4") && !adA.asksToMoveOn("I think the answer is 3"));
  const askedBefore = [{ role: "assistant", text: "Nice. What formula can you use to expand sin(2θ) into single angles?" }, { role: "user", text: "sin(θ+θ)" }];
  check("re-asking an earlier question is detected; a new question is not", adA.repeatsRecentQuestion("Good. What formula can you use to expand sin(2θ) into single angles?", askedBefore) && !adA.repeatsRecentQuestion("Good. What is cos θ if sin θ = 3/5?", askedBefore));
  const openP = { id: "p1", question: "Given sin θ = 3/5, find sin(2θ).", answer: "24/25", createdAt: new Date().toISOString() };
  script = (b, i) => i === 0 ? { content: "", tool_calls: [tc("CREATE_PROBLEM", { question: "What is the area of a circle of radius 3, in terms of π?", answer: "9π" })] } : { content: "What formula expands sin(2θ)?" };
  r = await run("I'm not sure", { problems: [openP], history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("no new exercise while one is unanswered (rejected, nothing piled on)", r.problems.length === 0 && /haven't answered the exercise/.test(JSON.stringify(calls[1].messages)));
  r = await run("another one please", { problems: [openP], history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("...but the student asking for another one gets it", r.problems.length === 1);
  r = await run("next", { problems: [{ ...openP, solved: true }], history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("...and once the previous one is solved a new one is fine", r.problems.length === 1);

  // ---- the neural RL policy learns a student's preferences ----
  {
    const r = P.rng(42);
    let pol = P.initPolicy(3);
    const calm = { reaction: "attempt", stuckStreak: 0, turn: 6, subject: "Math", hour: 17, messageWords: 12, hasMaths: true, recentWrong: 0, repeatedStudent: false };
    const stuck = { ...calm, reaction: "frustrated", stuckStreak: 2, recentWrong: 1 };
    // a simulated student: stuck → a PICTURE helps and slowing down helps; flowing → a probing question works, stretching is welcome
    const reward = (c, a) => { let x = 0.25 + (c === stuck ? (a.move === "visual" ? 0.55 : 0) + (a.pace === "slow" ? 0.15 : 0) : (a.move === "probe" ? 0.45 : 0) + (a.pace === "stretch" ? 0.2 : 0)); return Math.min(1, x + (r() - 0.5) * 0.1); };
    const before = P.summarize(pol);
    for (let n = 0; n < 1500; n++) { const c = n % 2 ? stuck : calm; const a = P.act(pol, c, r); pol = P.learn(pol, a.exp, reward(c, a)); }
    const after = P.summarize(pol);
    check("the RL policy starts uninformed and (after training on a simulated student) learns picture+slow when stuck and probe+stretch when flowing", before.updates === 0 && after.updates === 1500 && after.stuck.move === "visual" && after.stuck.pace === "slow" && after.flow.move === "probe" && after.flow.pace === "stretch");
    const fp = P.forward(pol, P.featuresFor(stuck)).pm;
    check("probabilities stay a valid distribution and exploration never dies (every move keeps a floor when sampling)", Math.abs(fp.reduce((a, b) => a + b, 0) - 1) < 1e-9 && (() => { const seen = new Set(); const rr = P.rng(5); for (let n = 0; n < 3000; n++) seen.add(P.act(pol, stuck, rr).move); return seen.size === P.MOVES.length; })());
    check("a move that just failed is never served twice in a row", (() => { const rr = P.rng(9); for (let n = 0; n < 400; n++) if (P.act(pol, stuck, rr, "visual").move === "visual") return false; return true; })());
    const rt = P.parsePolicy(JSON.parse(JSON.stringify(pol)));
    check("the policy round-trips through JSON (persisted per student) and corrupt state is rejected", !!rt && rt.updates === 1500 && P.parsePolicy({ v: 1, W1: [1] }) === null && P.parsePolicy(null) === null);
    check("features have the declared dimension and are bounded", P.featuresFor(stuck).length === P.FEATURE_DIM && P.featuresFor(stuck).every((v) => v >= 0 && v <= 1));
  }
  {
    // end to end through planTurn: it scores the previous action from the student's reaction and updates the weights
    const hist = [{ role: "user", text: "find sin(5π/12)" }, { role: "assistant", text: "What two special angles add to 5π/12?" }];
    const p1 = adA.planTurn({ userKey: "rl:t1", message: "no idea", history: hist.slice(0, 1), subject: "Math", policy: null, rng: P.rng(1) });
    const p2 = adA.planTurn({ userKey: "rl:t1", message: "oh pi over four plus pi over six!", history: hist, subject: "Math", policy: p1.policy, rng: P.rng(2) });
    check("planTurn learns from the student's reaction to the previous move (reward high for a good reply) and returns a move + pace directive", !p1.learned && p2.learned && p2.learned.reward >= 0.75 && p2.policy.updates === 1 && /TEACHING MOVE THIS TURN/.test(p2.line) && /PACE THIS TURN/.test(p2.line));
    const p3 = adA.planTurn({ userKey: "rl:t1", message: "I told you I don't get it", history: [...hist, { role: "user", text: "x" }, { role: "assistant", text: "y" }], subject: "Math", policy: p2.policy, rng: P.rng(3) });
    check("a frustrated reply is a zero reward for the previous move and that move is not repeated", p3.learned.reward === 0 && p3.move !== p2.move);
  }

  // Latency: an interactive tutor turn is bounded in model rounds (it used to allow 7), and the tutor stage skips Pronote/connected-app lookups.
  let nWrites = 0;
  script = (b, i) => i < 6 ? { content: "", tool_calls: [tc("WRITE_TO_BOARD", { text: "Note number " + (nWrites++) + " about the unit circle and radians", kind: "note" })] } : { content: "Which angle first?" };
  await run("keep going", { history: [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }] });
  check("an interactive tutor turn makes at most 4 model rounds even if the model keeps calling tools (was 7)", calls.length <= 4);
  const idx = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const cl = readFileSync(new URL("../server/claude.ts", import.meta.url), "utf8");
  check("Primer turns skip the Pronote + connected-app network lookups, and provider attempts have timeouts (Gemini 9s, DeepSeek 24s) so a stalled one fails over fast", /req\.body\?\.primer !== true && \(await pronoteSvc\.pronoteConnected/.test(idx) && /req\.body\?\.primer === true \? undefined : await toolsFor\(req\)/.test(idx) && /9_000 : 24_000/.test(cl) && /CHAT_DEADLINE_MS = opts\?\.primer \? 45_000 : 120_000/.test(cl));

  // "Done — 50 cards" with no deck behind it (reported live)
  check("a follow-up like 'make them ps' after talk of cards keeps the artifact tools available", wantsArtifactTools("make them ps", [{ role: "user", text: "make 50 flashcards" }, { role: "assistant", text: "Done — 50 cards covering scarcity" }]) && wantsArtifactTools("make more", []) && !wantsArtifactTools("ok thanks", []));
  script = (b, i) => i === 0 ? { content: "Done — 50 cards covering scarcity, PPCs and elasticity." } : i === 1 ? { content: "", tool_calls: [tc("CREATE_FLASHCARDS", { title: "Paper 1 prep", cards: [{ front: "Define scarcity", back: "Limited resources vs unlimited wants" }, { front: "XED > 0 means", back: "Substitutes" }] })] } : { content: "Made the deck — it's in your prepared items." };
  calls = [];
  const rd = await chatAboutTask({ title: "DST prep", why: "", source: "manual" }, [{ role: "user", text: "hi" }, { role: "assistant", text: "ok" }], "ok", undefined, undefined, {});
  check("a reply claiming 'Done — 50 cards' with no deck gets one corrective round that makes the real deck (tools force-offered even on small talk)", rd.flashcards.length === 1 && calls.length >= 2 && /CREATE_FLASHCARDS/.test(JSON.stringify(calls[1].messages)) && calls[1].tools.some((x) => x.function?.name === "CREATE_FLASHCARDS"));
  check("the task chat gets the board guidance (question on the board, no claimed-but-uncalled artifacts)", /THE BOARD IS PART OF THIS CHAT/.test(String(calls[0].messages[0].content)) && /never\s+claim you made flashcards/.test(String(calls[0].messages[0].content)));
}
