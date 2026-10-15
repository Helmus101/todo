// The structured tutor turn (server/tutorTurn/*) against a scripted fake model: globalThis.fetch is intercepted for
// api.deepseek.com and returns the JSON turn each test scripts — so the REAL engine (facts, one call, verify, one
// repair, degrade, board ops) runs with no network and no key. Plus pure unit tests of the parser, the support
// policy, the verifier and the board ops. Wired into tests/run.mjs.
process.env.DEEPSEEK_API_KEY ||= "sim-key";
delete process.env.GEMINI_API_KEY;

export async function runTutorTurnSim(check, section) {
  let script = () => ({});
  let calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("api.deepseek.com")) return realFetch(url, init);
    const body = JSON.parse(init.body);
    calls.push(body);
    const out = script(body, calls.length - 1);
    if (out && out.fail) return new Response(JSON.stringify({ error: { message: "boom" } }), { status: out.status || 500, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ id: "sim", object: "chat.completion", model: "sim", choices: [{ index: 0, message: { role: "assistant", content: typeof out === "string" ? out : JSON.stringify(out) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { runTutorTurn, factsBlock } = await import("../server/tutorTurn/engine.ts");
    const { supportPolicy, nextSupportState, asksForWorkedExample } = await import("../server/tutorTurn/policy.ts");
    const { verifyTurn, degradeTurn, wordBudget } = await import("../server/tutorTurn/verify.ts");
    const { applyOps } = await import("../server/tutorTurn/apply.ts");
    const { normalizeTurn, extractJsonObject, MOVE_SUPPORT } = await import("../shared/tutorTurn.ts");
    const { buildNumberLine, buildBalance } = await import("../shared/simpleScenes.ts");
    const { TURN_PROMPT } = await import("../server/tutorTurn/prompt.ts");

    const T = (o) => ({ heard: "x", intent: "other", diagnosis: { status: "none" }, move: "elicit", support: 0, speech: ["What do you notice?"], board: [], expects: "open", ...o });
    const board = [
      { id: "g", n: 1, kind: "given", text: "Masses $M$ on a slope at $\\theta$, $m$ hanging", at: "a" },
      { id: "s", n: 2, kind: "formula", owner: "student", text: "$Mg\\sin\\theta - T = Ma$", at: "b" },
    ];
    const base = { history: [{ role: "user", text: "hi" }, { role: "assistant", text: "Hey! What are we working on?" }], board, problems: [], objectives: [], context: {}, lang: "en" };
    const sol = { statement: "find a", steps: [], value: 2.45, finalAnswer: "2.45", verified: true };
    const systemOf = (b) => String(b.messages.find((m) => m.role === "system")?.content || "");
    const lastUser = (b) => String([...b.messages].reverse().find((m) => m.role === "user")?.content || "");

    section("Structured tutor turn — parser, policy, verifier, board ops (pure)");
    check("the JSON is read leniently (fence, synonyms, speech as one string) and values are clamped to the enums",
      (() => { const t = normalizeTurn(extractJsonObject('```json\n{"interpretation":{"heard":"h","intent":"ask why"},"move":"EXPLAIN","support_level":9,"speech":"One. Two?","board_actions":[{"type":"mark","cue":7,"target":"#2","style":"zigzag"}]}\n```'));
        return t && t.intent === "ask_why" && t.move === "explain" && t.support === 5 && t.speech.length === 2 && t.board[0].op === "mark" && t.board[0].cue === 1 && !t.board[0].style; })());
    check("no speech → no turn (the engine retries instead of shipping nothing)", normalizeTurn({ move: "elicit", speech: [] }) === null && normalizeTurn("x") === null);
    check("support may rise one level a turn; a right step drops it", supportPolicy({ teaching: { lastSupport: 1, stuckStreak: 0, helpLevel: 0, turns: 3 }, needsExplanation: false, asksWhy: false, asksForWorkedExample: false }).maxSupport === 2 && supportPolicy({ teaching: { lastSupport: 3, stuckStreak: 0, helpLevel: 0, turns: 3 }, needsExplanation: false, asksWhy: false, asksForWorkedExample: false, verdict: "correct" }).maxSupport === 1);
    check("lost / why / stuck twice unlock explaining at once; a worked example needs a request or a long struggle",
      supportPolicy({ needsExplanation: true, asksWhy: false, asksForWorkedExample: false }).allowed.includes("explain") &&
      supportPolicy({ needsExplanation: false, asksWhy: true, asksForWorkedExample: false }).allowed.includes("explain") &&
      supportPolicy({ teaching: { unproductive: 2, stuckStreak: 0, helpLevel: 0, turns: 4 }, needsExplanation: false, asksWhy: false, asksForWorkedExample: false }).allowed.includes("explain") &&
      !supportPolicy({ needsExplanation: true, asksWhy: false, asksForWorkedExample: false }).allowed.includes("worked_example") &&
      supportPolicy({ needsExplanation: false, asksWhy: false, asksForWorkedExample: asksForWorkedExample("can you show me the full solution") }).allowed.includes("worked_example"));
    check("the struggle count only grows on a wrong attempt or a stuck message; progress resets it",
      nextSupportState({ unproductive: 1 }, { move: "focus", progressed: false, struggled: true }).unproductive === 2 &&
      nextSupportState({ unproductive: 1 }, { move: "elicit", progressed: false, struggled: false }).unproductive === 1 &&
      nextSupportState({ unproductive: 3 }, { move: "confirm", verdict: "correct", progressed: true, struggled: false }).unproductive === 0);
    check("every move has a support level and the prompt names them all", Object.keys(MOVE_SUPPORT).every((m) => TURN_PROMPT.includes(m)) && MOVE_SUPPORT.explain === 4 && MOVE_SUPPORT.worked_example === 5);

    const policy = supportPolicy({ teaching: { lastSupport: 0, stuckStreak: 0, helpLevel: 0, turns: 2 }, needsExplanation: false, asksWhy: false, asksForWorkedExample: false });
    const vctx = { message: "so a is 3", history: base.history, board, problems: [], solution: sol, policy, wants: { why: false, write: false, restart: false, exercise: false }, said: ["so a is 3"], discussion: false };
    const codes = (t, c = vctx) => verifyTurn(T(t), c).map((i) => i.code);
    check("verify: too much help, a leaked final answer, a pointer at a missing line, two questions", (() => { const c = codes({ move: "worked_example", speech: ["So a = 2.45.", "Is that clear?", "Look at line 9?"] }); return ["support", "leak", "target", "questions"].every((x) => c.includes(x)); })());
    check("verify: a clean focusing turn passes", codes({ move: "focus", speech: ["Check the sign of T in line 2.", "Which way does the string pull M?"], board: [{ op: "mark", cue: 0, target: "#2", style: "underline", part: "T", tone: "hint" }] }).length === 0);
    check("verify: a why answered with the instruction again is caught; a reason passes",
      verifyTurn(T({ move: "hint_procedure", speech: ["Multiply the volume by the energy per cm³.", "What do you get?"] }), { ...vctx, wants: { ...vctx.wants, why: true }, policy: supportPolicy({ needsExplanation: false, asksWhy: true, asksForWorkedExample: false }) }).some((i) => i.code === "intent_why") &&
      !verifyTurn(T({ move: "explain", speech: ["Because each cm³ gives 30 kJ, so the volume tells you how many lots of 30 kJ you get.", "What does one hour give?"] }), { ...vctx, wants: { ...vctx.wants, why: true }, policy: supportPolicy({ needsExplanation: false, asksWhy: true, asksForWorkedExample: false }) }).some((i) => i.code === "intent_why"));
    check("verify: length budget per move", codes({ move: "confirm", speech: [Array(60).fill("word").join(" ") + "."] }).includes("length") && wordBudget("explain") > wordBudget("focus"));
    check("degrade: the leaking sentence, the extra question and the bad mark go; the model's other words stay", (() => {
      const d = degradeTurn(T({ move: "focus", speech: ["Nice try.", "The answer is 2.45 actually.", "Is it clear?", "What's the net force on m?"], board: [{ op: "mark", cue: 1, target: "#9", note: "x" }, { op: "draw", cue: 0, scene: "graph" }, { op: "draw", cue: 0, scene: "flow" }] }), vctx);
      return d.speech.join(" ") === "Nice try. What's the net force on m?" && d.board.length === 1 && d.board[0].op === "draw"; })());

    const actx = { message: "x", theirWords: ["T - mg = ma"], board, problems: [], fr: false };
    check("apply: a mark points at a real line, keeps the part only when it's in the line, and carries its cue", (() => { const a = applyOps([{ op: "mark", cue: 2, target: "#2", style: "circle", part: "-T", tone: "focus", note: "the pull back" }, { op: "mark", cue: 0, target: "#2", style: "box", part: "zzz", tone: "error" }], actx); return a.board.length === 2 && a.board[0].markStyle === "circle" && a.board[0].markPart === "-T" && a.board[0].cue === 2 && !a.board[1].markPart && a.board[0].targetId === "s"; })());
    check("apply: a gap's key is computed from the line when it can be; a typed plain step is typeset; their ink only when it's their numbers", (() => {
      const a = applyOps([{ op: "gap", cue: 0, text: "$12 \\times 3 = ?$", expected: "38" }, { op: "step", cue: 0, text: "T - mg = ma", owner: "student" }, { op: "step", cue: 0, text: "$v = 14$", owner: "student" }], actx);
      return a.board[0].expectedAnswer === "36" && a.board[1].text === "$T - mg = ma$" && a.board[1].owner === "student" && a.board[2].owner !== "student"; })());
    check("apply: one visual a turn, a repeated equation isn't written again", (() => { const a = applyOps([{ op: "step", cue: 0, text: "$Mg\\sin\\theta - T = Ma$" }, { op: "draw", cue: 0, scene: "numberline", spec: { min: 0, max: 5, points: [{ x: 2, label: "a" }] } }, { op: "draw", cue: 0, scene: "balance", spec: { left: ["2x", "3"], right: ["7"] } }], actx); return a.board.length === 1 && a.board[0].kind === "svg" && a.dropped.length === 2; })());
    check("number line and balance scenes build to clean SVG", "svg" in buildNumberLine({ min: -2, max: 4, points: [{ x: 1, label: "x" }], intervals: [{ from: 1, to: 3, open: "right" }] }) && "svg" in buildBalance({ left: ["2x", "3"], right: ["7"] }) && "error" in buildBalance({ left: [], right: ["7"] }));
    check("facts tell the model the limit, the verified step and what they asked for", (() => { const f = factsBlock({ policy, verdict: { gap: "a = ?", given: "3", verdict: "incorrect" }, wants: { why: true, write: true, restart: false, exercise: false, explain: false }, affect: "neutral" }); return /up to level 1/.test(f) && /WRONG/.test(f) && /ASKED WHY/.test(f) && /WRITE THEIR WORKING/.test(f); })());

    section("Structured tutor turn — the real engine against a scripted model");
    script = () => T({ heard: "lost, wants to restart", intent: "restart", diagnosis: { status: "unclear" }, move: "explain", support: 4, speech: ["Let's rebuild it slowly.", "The string pulls both masses with the same force, T.", "On the slope, gravity pulls M down and T pulls it back.", "What pulls on the hanging mass m?"], board: [{ op: "topic", cue: 0, text: "Starting again: connected masses" }, { op: "mark", cue: 2, target: "#2", style: "circle", part: "-T", tone: "focus", note: "the string pulling back" }, { op: "draw", cue: 1, scene: "incline", text: "M on the slope", spec: { angle: 30, forces: ["weight", "components"] } }] });
    calls = [];
    let r = await runTutorTurn({ ...base, message: "can we start over I don't understand" });
    check("an explanation when they're lost ships in ONE call, with the header, the circle and the figure, each on its sentence", calls.length === 1 && !r.error && /rebuild it slowly/.test(r.reply) && r.board.map((b) => b.kind).join() === "focus,annotation,svg" && r.board[1].cue === 2 && r.turn.move === "explain");
    check("the call uses JSON mode and the prompt carries the facts (explaining allowed now)", calls[0].response_format?.type === "json_object" && /SUPPORT ALLOWED THIS TURN: up to level 4/.test(systemOf(calls[0])) && /START OVER/.test(systemOf(calls[0])));

    script = (b, i) => i === 0 ? T({ intent: "answer", diagnosis: { status: "slip" }, move: "worked_example", support: 5, speech: ["So a = 2.45.", "Is that clear?", "Look at line 9?"], board: [{ op: "mark", cue: 0, target: "#9", note: "here" }] })
      : T({ intent: "answer", diagnosis: { status: "slip" }, move: "focus", support: 1, speech: ["Close — check the sign of T in line 2.", "Which way does the string pull M?"], board: [{ op: "mark", cue: 0, target: "#2", style: "underline", part: "T", tone: "hint" }] });
    calls = [];
    r = await runTutorTurn({ ...base, message: "so a is 3", solution: sol });
    check("a turn that gives too much, leaks, points at nothing and asks twice gets ONE repair call, and the repaired turn ships", calls.length === 2 && /check the sign of T/.test(r.reply) && r.turn.repaired && /too much help/.test(lastUser(calls[1])) && /final answer/.test(lastUser(calls[1])) && !/2\.45/.test(r.reply));

    script = () => T({ intent: "answer", diagnosis: { status: "slip" }, move: "focus", support: 1, speech: ["Nice try.", "The answer is 2.45 actually.", "What's the net force on m?"], board: [{ op: "mark", cue: 1, target: "#9", note: "x" }] });
    calls = [];
    r = await runTutorTurn({ ...base, message: "so a is 3", solution: sol });
    check("when the repair fails too, code removes only what must not ship — no stock sentence is added", r.reply === "Nice try. What's the net force on m?" && r.board.length === 0 && r.guardrailTripped);

    script = () => T({ intent: "write_my_work", move: "confirm", speech: ["Sure.", "What's next for m?"] });
    r = await runTutorTurn({ ...base, message: "can you write T - mg = ma on the board" });
    check("'write what I wrote' always ends with their line on the board, typeset, in their ink", r.board.some((b) => b.owner === "student" && b.text === "$T - mg = ma$"));

    script = (b, i) => i === 0 ? "Sure thing! WRITE_TO_BOARD(gap, x=?)" : T({ intent: "chat", speech: ["Hey — what are we working on today?"] });
    calls = [];
    r = await runTutorTurn({ ...base, message: "hi" });
    check("text that isn't the JSON turn is never shown: one retry, and the student only sees the real turn", calls.length === 2 && r.reply === "Hey — what are we working on today?");

    script = (b, i) => i === 0 ? { fail: true, status: 400 } : T({ speech: ["Which force pulls m up?"] });
    calls = [];
    r = await runTutorTurn({ ...base, message: "ok" });
    check("a provider that rejects JSON mode gets the same request without it", calls.length === 2 && !calls[1].response_format && r.reply === "Which force pulls m up?");

    script = () => T({ intent: "new_problem", move: "practice", speech: ["Here's one to try."], board: [{ op: "problem", cue: 0, question: "Qd = 500 - 20P and Qs = 100 + 30P. Find P.", answer: "8", check: "400/50", format: "a whole number" }, { op: "plan", cue: 0, objectives: ["Equilibrium price", "Demand shifts"] }] });
    r = await runTutorTurn({ ...base, message: "give me a problem on equilibrium" });
    check("an exercise and a plan land as real objects (answer key code-checked)", r.problems.length === 1 && r.problems[0].answer === "8" && r.objectives?.length === 2);

    {
      const leaky = normalizeTurn({ heard: "x", intent: "other", diagnosis: { status: "unclear" }, move: "elicit", support: 1, speech: ["Nice work. #%%call:default_api:write_board{\"text\":\"x\"}", "WRITE_TO_BOARD(gap, \"x\") What is 2 plus 2?"], board: [{ op: "topic", cue: 0, text: "Sums #%%call:default_api:" }], expects: "answer" });
      check("tool-call text in speech or on the board never survives parsing (reported live: '#%%call:default_api:')", !!leaky && !/default_api|%%|WRITE_TO_BOARD|call:/i.test(JSON.stringify(leaky)) && leaky.speech.join(" ").includes("What is 2 plus 2?"));
    }
    {
      const { adaptationLines } = await import("../server/tutorTurn/policy.ts");
      const rec = (o) => ({ at: "x", move: "elicit", support: 1, intent: "answer", diagnosis: "none", words: 20, studentWords: 10, repaired: false, ms: 1, ...o });
      const failed = adaptationLines([rec({ move: "explain", support: 4, angle: "picture" })], { wrong: true, stuck: false });
      check("a failed explanation is not repeated: the next turn is told to change angle, and which angles are used", failed.length === 1 && /DID NOT LAND/.test(failed[0]) && /picture/.test(failed[0]));
      check("a student who is flying alone gets less help", adaptationLines([rec({ verdict: "correct" }), rec({ verdict: "correct" })], { wrong: false, stuck: false }).some((l) => /moving fast/.test(l)));
      check("nothing special is said when nothing needs adapting", adaptationLines([rec({ move: "confirm", verdict: "correct", support: 2 })], { wrong: false, stuck: false }).length === 0);
    }
    {
      const { sessionGuide } = await import("../server/tutorTurn/guide.ts");
      const rec = (o) => ({ at: "x", move: "elicit", support: 1, intent: "answer", diagnosis: "none", words: 20, studentWords: 10, repaired: false, ms: 1, ...o });
      const u = (t) => ({ role: "user", text: t }), a = (t) => ({ role: "assistant", text: t });
      const g = (o) => sessionGuide({ message: "ok", history: [u("x"), a("y"), u("ok")], log: [], correctNow: false, openWork: false, hasObjectives: true, ...o }).join("\n");
      check("the first turn of a sitting opens with a plan, not 'where do you want to start'", /OPEN THE SITTING WITH A PLAN/.test(g({ history: [u("lets continue")], message: "lets continue" })) && !/OPEN THE SITTING/.test(g({})));
      check("with no objectives the opening asks for a plan op", /plan op/.test(g({ history: [u("hi")], message: "hi", hasObjectives: false })));
      check("a right answer is made solid before moving on (why / variation / own words)", /MAKE IT SOLID/.test(g({ correctNow: true })) && /SOLID NOW/.test(g({ correctNow: true, log: [rec({ move: "probe_why" })] })));
      check("asking to switch while the topic isn't solid: finish it quickly, then switch; a second ask switches at once", /come back to it/.test(g({ message: "lets do trig actually", openWork: true })) && /AGAIN: do it now/.test(g({ message: "actually partial fractions", history: [u("a"), a("b"), u("lets do trig actually"), a("c"), u("actually partial fractions")], openWork: true })));
      check("a solid topic can be left when asked", !/SWITCH TOPICS/.test(g({ message: "lets do trig", log: [rec({ verdict: "correct" }), rec({ verdict: "correct" })] })));
      check("the board is checked before asking for a value", /already on a line/.test(g({})));
    }
    {
      const { salvageTurn, normalizeTurn } = await import("../shared/tutorTurn.ts");
      const cut = '{"heard":"x","move":"explain","speech":["Think of it as a slope.","Each step right goes up two.",';
      check("a reply cut off mid-JSON still yields the sentences it finished", normalizeTurn(salvageTurn(cut))?.speech.length === 2 && normalizeTurn(salvageTurn(cut)).move === "explain");
      check("a trailing comma is forgiven", normalizeTurn(salvageTurn('{"speech":["Hello there friend."],}'))?.speech[0] === "Hello there friend.");
      check("plain prose is only used as a last resort", salvageTurn("Let us look at the slope together now.") === null && normalizeTurn(salvageTurn("Let us look at the slope together now.", { prose: true }))?.speech.length === 1);
    }
    {
      // Reported live: "can you draw the sign chart" → Otto talked about a chart, drew nothing, then said "take a look at the chart on the board".
      const noOp = T({ heard: "wants the sign chart", intent: "check", diagnosis: { status: "none" }, move: "explain", support: 4, speech: ["A sign chart shows where sine is positive or negative.", "Let's map out all four quadrants on a grid.", "Which quadrants make sine positive?"], board: [], expects: "open" });
      const withTable = T({ heard: "wants the sign chart", intent: "check", diagnosis: { status: "none" }, move: "explain", support: 4, speech: ["A sign chart shows where sine is positive or negative.", "Here are the four quadrants on the board.", "Which quadrants make sine positive?"], board: [{ op: "draw", cue: 1, scene: "table", text: "Sign of sine by quadrant", spec: { headers: ["Quadrant", "sin"], rows: [["I", "+"], ["II", "+"], ["III", "-"], ["IV", "-"]] } }], expects: "open" });
      script = (b, i) => (i === 0 ? noOp : withTable);
      calls = [];
      let d = await runTutorTurn({ ...base, message: "um can you also can you draw the sign chart please" });
      check("asked to draw and nothing drawn: ONE repair call, and the chart really lands on the board", calls.length === 2 && d.board.some((e) => e.kind === "table") && /four quadrants on the board/.test(d.reply));
      check("the repair instruction says to draw it now", /do it NOW/.test(JSON.stringify(calls[1].messages)));
      script = (b, i) => (i === 0 ? noOp : noOp);
      d = await runTutorTurn({ ...base, message: "can you draw the sign chart" });
      check("if it still won't draw, the speech never claims the board", !/on the board|let's map/i.test(d.reply) || d.board.length > 0);
      const { acceptsBoardOffer, claimsBoard } = await import("../server/tutorTurn/verify.ts");
      check("'yeah can you do that' after Otto offered to map the quadrants counts as a request to draw; after a plain question it doesn't", acceptsBoardOffer("yeah can you do that", [{ role: "assistant", text: "Let's map out all four quadrants on a simple grid." }]) && !acceptsBoardOffer("yeah", [{ role: "assistant", text: "What is the radius?" }]));
      check("board claims are recognised, plain teaching isn't", claimsBoard("Take a look at the sign chart on the board.") && claimsBoard("I'll draw the grid.") && !claimsBoard("Sine is positive where y is positive."));
    }
    {
      const { levelLine, backgroundBlock } = await import("../server/tutor.ts");
      const prof = { about: "", preferences: [], people: [], projects: [], courses: ["Maths AA HL", "Physics SL"], sessions: [], yearLevel: "DP1", track: "ib" };
      const lv = levelLine(prof, "Math");
      check("their level comes from Settings: year, programme and courses, with an instruction to pitch at it", /year\/grade "DP1"/.test(lv) && /IB Diploma/.test(lv) && /Maths AA HL/.test(lv) && /don't use methods from later years/.test(lv));
      check("nothing is said about level when Settings has none", levelLine({ about: "", preferences: [], people: [], projects: [], courses: [], sessions: [] }, "Math") === "");
      const bg = backgroundBlock({ profile: prof, subject: "Math", memory: [{ when: "yesterday", subject: "Math", lines: ["Partial fractions"], asked: ["why A over x+1"] }] });
      check("the tutor's background carries the level and uses the on-device memory to plan", /THEIR LEVEL/.test(bg) && /Partial fractions/.test(bg) && /USE THAT MEMORY/.test(bg));
    }
    {
      const { sameExercise, exercisesSoFar, questionKind, recentQuestionKinds, varietyLine } = await import("../server/tutorTurn/exercises.ts");
      const { vagueReply } = await import("../server/tutorTurn/verify.ts");
      const { sessionGuide } = await import("../server/tutorTurn/guide.ts");
      const { cleanVisionText } = await import("../server/ai/voice.ts");
      const old = "What do you get when you transform h(x) = 2sin(3x) from f(x) = sin(x) for the amplitude?";
      check("a reworded repeat of an exercise is the same exercise; a different function is not", sameExercise(old, "How does h(x) = 2sin(3x) change from f(x) = sin(x), and what is the amplitude?") && !sameExercise(old, "What do you get when you transform g(x) = 3cos(2x) from f(x) = cos(x) for the period?"));
      const hist = [];
      hist.push({ role: "assistant", text: "Let's start. " + old });
      for (let k = 0; k < 8; k++) hist.push({ role: k % 2 ? "assistant" : "user", text: k % 2 ? "Good, now think about it." : "ok" });
      check("exercises asked beyond the 14-message window and in past sessions are still remembered", exercisesSoFar({ history: hist, problems: [], memory: [{ done: ["Find the slant asymptote of f(x) = (2x^2 - 3x + 4)/(x - 2)?"] }] }).length === 2);
      check("question kinds: error-spotting, sketching, why, compute", questionKind("Can you spot the mistake in line 2?") === "spot_error" && questionKind("Sketch the graph of y = 2sin(x)?") === "sketch" && questionKind("Why does the period halve?") === "explain_why" && questionKind("What is cos(2pi)?") === "compute");
      check("variety: after two computes the next is asked to be a different kind", /spot_error|sketch|predict|compare|explain_why/.test(varietyLine(recentQuestionKinds([{ role: "assistant", text: "What is cos(2pi)?" }, { role: "assistant", text: "What is sin(3pi/2)?" }]))));
      const T0 = (speech, move = "elicit", board = []) => ({ speech, move, board, heard: "", intent: "other", diagnosis: { status: "none" }, support: 1, expects: "open" });
      const vc = { message: "ok", history: [], board: [], problems: [], policy: {}, wants: {}, said: [], discussion: false };
      check("a reply that says nothing in particular is caught (too short / hands nothing back / touches nothing)", !!vagueReply(T0(["Sure."]), vc) && !!vagueReply(T0(["Let's switch to the next part of your preparation now."]), vc) && vagueReply(T0(["Take the vertex form of the parabola.", "Which way does it open?"]), { ...vc, message: "vertex form of the parabola" }) === null);
      check("a concrete maths question passes", vagueReply(T0(["What is the amplitude of $y = 2\\sin(3x)$?"]), vc) === null);
      const g = sessionGuide({ message: "ok", history: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "user", text: "ok" }], log: [1, 2, 3].map(() => ({ at: "x", move: "elicit", support: 1, intent: "answer", diagnosis: "none", verdict: "correct", words: 10, studentWords: 5, repaired: false, ms: 1 })), correctNow: false, openWork: false, hasObjectives: true, level: "DP1, Maths AA HL" }).join("\n");
      check("difficulty is pitched at their level, questions come from the board, and a streak raises it", /DP1, Maths AA HL/.test(g) && /TOO EASY/.test(g) && /BUILD QUESTIONS FROM THE BOARD/.test(g) && /HARDER than any so far/.test(g));
      check("a drawing in the message is answered with its specific features, never blind praise", /THEY DREW OR WROTE/.test(sessionGuide({ message: "is it like this [What I wrote/drew on the board: TEXT: x]", history: [], log: [], correctNow: false, openWork: false, hasObjectives: true }).join("\n")));
      check("the image reader's preamble and markdown are stripped", cleanVisionText("Based on the image provided, here is a literal transcription:\n\n### Text\n**TEXT:** x^2") === "Text\nTEXT: x^2");
      // a model that repeats an old exercise gets ONE repair that names it
      const dupTurn = T({ heard: "ok", intent: "chat", diagnosis: { status: "none" }, move: "practice", support: 1, speech: ["Let's check it once more.", "What do you get when you transform h(x) = 2sin(3x) from f(x) = sin(x) for the amplitude?"], board: [], expects: "value" });
      const freshTurn = T({ heard: "ok", intent: "chat", diagnosis: { status: "none" }, move: "practice", support: 1, speech: ["Now a different one.", "A buoy rises and falls 1.5 m every 8 seconds; which function models its height, and what is its period?"], board: [], expects: "value" });
      const GEN = (o = {}) => ({ topic: "Ocean waves", question: "A buoy rises and falls 1.5 m every 8 seconds. What is the frequency of its motion in hertz?", answer: "0.125", check: "1/8", format: "a number, in Hz", hint: "Frequency is the inverse of the period.", why: "f = 1/T", intro: "Here is a new one, about waves this time.", ...o });
      script = (b, i) => (/write ONE exercise/.test(systemOf(b)) ? GEN() : i === 0 ? dupTurn : freshTurn);
      calls = [];
      const rr = await runTutorTurn({ ...base, history: hist, message: "ok next" });
      check("an exercise already used earlier is repaired (one repair call names the old one) and the new exercise comes from the generator, in the widget", calls.length === 3 && /already used/.test(JSON.stringify(calls[1].messages)) && rr.problems.length === 1 && /buoy/.test(rr.problems[0].question) && !/2sin\(3x\)/.test(rr.reply) && /new one/.test(rr.reply));
    }
    {
      const { verifyTurn } = await import("../server/tutorTurn/verify.ts");
      const { buildRecap } = await import("../server/tutorTurn/ledger.ts");
      const mk = (o) => ({ speech: ["Think of the slope as steepness.", "Which way does it lean?"], move: "explain", board: [], heard: "", intent: "other", diagnosis: { status: "none" }, support: 4, expects: "open", ...o });
      const vc = { message: "ok", history: [], board: [], problems: [], policy: { maxSupport: 5, allowed: [], reason: "" }, wants: {}, said: [], discussion: false };
      const codes = (t, c = {}) => verifyTurn(t, { ...vc, ...c }).map((i) => i.code);
      check("teaching that writes nothing on the board is flagged; with a step it passes", codes(mk({})).includes("unwritten") && !codes(mk({ board: [{ op: "step", cue: 0, text: "$m = \\Delta y/\\Delta x$" }] })).includes("unwritten"));
      check("a wrong answer diagnosed as nothing is flagged, and a misconception must be named and not just confirmed", codes(mk({ move: "focus", board: [{ op: "mark", cue: 0, target: "#1" }] }), { verdict: "incorrect" }).includes("diagnosis") && codes(mk({ move: "confirm", diagnosis: { status: "misconception" } })).includes("diagnosis") && codes(mk({ move: "correct_error", diagnosis: { status: "misconception", misconception: "treats remainder as the line" }, board: [{ op: "step", cue: 0, text: "x" }] })).filter((c) => c === "diagnosis").length === 0);
      check("the recap lists the misconceptions that were worked on", buildRecap({ lang: "en", board: [], log: [{ at: "x", move: "correct_error", support: 3, intent: "answer", diagnosis: "misconception", misconception: "treats remainder as the line", words: 10, studentWords: 4, repaired: false, ms: 1 }] }).mistakes[0] === "Misconception worked on: treats remainder as the line");
    }
    {
      const { extractJsonObject, normalizeTurn, fixJsonBackslashes } = await import("../shared/tutorTurn.ts");
      const { repairLatex } = await import("../shared/mathText.ts");
      const { inventedObjects } = await import("../server/tutorTurn/verify.ts");
      const { sessionGuide } = await import("../server/tutorTurn/guide.ts");
      // Reported live: "F_ extresistive = kv²", "P = F_{total} imes v" — single-backslash LaTeX inside the model's JSON.
      const raw = '{"heard":"x","move":"elicit","speech":["Use the formula.","Line one\\nline two?"],"board":[{"op":"step","cue":0,"text":"$F_\\text{resistive} = kv^2$"},{"op":"step","cue":0,"text":"$P = F_{total} \\times v$"},{"op":"step","cue":0,"text":"$a=\\sin\\theta$"},{"op":"step","cue":0,"text":"$\\frac{1}{2}\\beta \\neq \\rho$"},{"op":"step","cue":0,"text":"$\\\\sqrt{2}$"}]}';
      const t = normalizeTurn(extractJsonObject(raw));
      check("single-backslash LaTeX in the model's JSON parses (it used to fail outright on \\sin) and comes out clean, with no tab characters", !!t && t.board.length === 5 && t.board[0].text === "$F_\\text{resistive} = kv^2$" && t.board[1].text === "$P = F_{total} \\times v$" && t.board[2].text === "$a=\\sin\\theta$" && t.board[3].text === "$\\frac{1}{2}\\beta \\neq \\rho$" && !/[\t\f\b\r]/.test(JSON.stringify(t.board)));
      check("a real \\n and an already-doubled backslash are left alone", JSON.parse(fixJsonBackslashes('{"a":"x\\ny","b":"\\\\frac"}')).a === "x\ny" && JSON.parse(fixJsonBackslashes('{"b":"\\\\frac"}')).b === "\\frac");
      check("boards already saved with the corrupted characters render again", repairLatex("F_\x09ext{resistive} = kv²") === "F_\\text{resistive} = kv²" && repairLatex("P = F\x09imes v") === "P = F\\times v" && repairLatex("\x0crac{1}{2}") === "\\frac{1}{2}");
      const src = ["A car of mass 1000 kg travels up a 10° slope at a steady speed of 15 m s-1."];
      check("an object the problem never mentioned is caught (the cyclist), a car is not", inventedObjects(["What total driving force must the cyclist maintain?"], src).includes("cyclist") && inventedObjects(["What total driving force must the car maintain?"], src).length === 0);
      const G = (o) => sessionGuide({ message: "ok", history: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "user", text: "ok" }], log: [], correctNow: false, openWork: false, hasObjectives: true, ...o }).join("\n");
      check("when they push back ('that is just equation', 'but we are asked power') Otto accepts and moves on, no more why", /PUSHED BACK/.test(G({ message: "that is just equation" })) && /PUSHED BACK/.test(G({ message: "but we are asked power" })) && !/MAKE IT SOLID/.test(G({ message: "that is just equation", correctNow: true })));
      check("when the exercise is finished: confirm, then a harder variation or the next item — no more 'why'", /THE EXERCISE IS DONE/.test(G({ correctNow: true, finalReached: true })) && !/MAKE IT SOLID/.test(G({ correctNow: true, finalReached: true })));
      check("pasted material: pick ONE question, quote it, put it on the board", /quoting its first words/.test(G({ message: "can we do energy like this\n1. What is the energy?\nA. 10 J\nB. 20 J\n2. What is the power?\n3. Why?" })) && !/PASTED/.test(G({ message: "ok" })));
    }
    {
      // Reported live: Otto talked about a bicycle and "work at a point" in a car-on-a-slope problem.
      const car = { id: "p1", question: "A car of mass 1000 kg travels up a 10 degree slope at a steady speed of 15 m per second. The resistive force is proportional to the square of the speed, 450 N at 15 m per second. What effective power is required?", answer: "32790", solved: false };
      const oldSol = { ...sol, statement: "A cyclist rides a bicycle of mass 80 kg along a flat road at 6 m per second and does work against drag over a long distance" };
      script = () => T({ heard: "ok", intent: "answer", diagnosis: { status: "none" }, move: "elicit", support: 1, speech: ["Start with the resistive force at 15 m per second.", "What is k in $F = kv^2$?"], board: [] });
      calls = [];
      await runTutorTurn({ ...base, problems: [car], solution: oldSol, message: "ok go on", history: [{ role: "user", text: "hi" }, { role: "assistant", text: "Hello." }] });
      const sys = systemOf(calls[0]);
      check("the current problem is stated to the model, and a saved solution for a different problem is not used", /THE PROBLEM RIGHT NOW[^]*car of mass 1000 kg/.test(sys) && !/cyclist/.test(sys));
    }
    {
      const { asksToWriteProblem, wantsDifferent, problemFromProse, problemStatement } = await import("../server/tutorTurn/intents.ts");
      const { asksToWrite } = await import("../server/tutorAdapt.ts");
      check("'write the problem on the board' (typos and all) is a request for the PROBLEM, not for their working", asksToWriteProblem("alriht write hte problem on board") && asksToWriteProblem("write problem on board") && asksToWriteProblem("put the question on the whiteboard please") && !asksToWriteProblem("write my steps on the board") && !asksToWriteProblem("what is the problem with this step"));
      check("'new problem', 'totally different', 'not the same idea' mean something different; an ordinary reply doesn't", wantsDifferent("alright new problem now") && wantsDifferent("no but not same idea just toally different".replace("toally", "totally")) && wantsDifferent("something else please") && !wantsDifferent("it is the same as before") && !wantsDifferent("Another one like it, please."));
      check("write-my-work is still write-my-work", asksToWrite("write my steps on the board"));
      const stated = "Let's switch to a connected masses problem to bring in tension. What is the acceleration of a 5 kg mass on a 30 degree frictionless slope connected by a string over a pulley to a 2 kg hanging mass?";
      check("the problem is lifted out of Otto's prose without the lead-in", problemFromProse(stated).startsWith("What is the acceleration of a 5 kg mass") && problemStatement({ history: [{ role: "assistant", text: stated }, { role: "user", text: "write problem on board" }] }).includes("2 kg hanging mass"));
      // the model answers "write the problem on the board" with only a question — the board still gets the problem
      script = () => T({ heard: "wants the problem on the board", intent: "write_my_work", diagnosis: { status: "none" }, move: "elicit", support: 1, speech: ["What expression gives the component of gravity pulling the 5 kg mass down the slope?"], board: [], expects: "value" });
      calls = [];
      const rp = await runTutorTurn({ ...base, board: [], problems: [], message: "write problem on board", history: [{ role: "user", text: "alright new problem now" }, { role: "assistant", text: stated }] });
      check("asked to put the problem on the board, the engine puts the full statement there as a given line even when the model only asked a question", rp.board.some((e) => e.kind === "given" && /5 kg mass/.test(e.text) && /2 kg hanging mass/.test(e.text)));
      check("and the repair instruction for that turn names the problem, not 'their step'", /PROBLEM on the board/.test(JSON.stringify(calls.map((c) => c.messages))));
      // a model that offers the same car setup again after "totally different" is repaired
      const car = { id: "p0", question: "A car of mass 1000 kg travels up a 10 degree slope at a steady speed of 15 m per second. The resistive force is proportional to the square of the speed, 450 N at 15 m per second. What effective power is required?", answer: "32790", solved: true };
      script = (b, i) => (i === 0
        ? T({ heard: "wants different", intent: "new_problem", diagnosis: { status: "none" }, move: "practice", support: 1, speech: ["Let's test that same idea with a different setup.", "A car of mass 1000 kg rolls down a 10 degree slope and the resistive force is 2 v squared. At what speed does it stop accelerating?"], board: [], expects: "value" })
        : T({ heard: "wants different", intent: "new_problem", diagnosis: { status: "none" }, move: "practice", support: 1, speech: ["Here is something new.", "A 5 kg mass on a 30 degree frictionless slope is tied by a string over a pulley to a 2 kg hanging mass. What is the acceleration?"], board: [], expects: "value" }));
      const GEN = (o = {}) => ({ topic: "Ocean waves", question: "A buoy rises and falls 1.5 m every 8 seconds. What is the frequency of its motion in hertz?", answer: "0.125", check: "1/8", format: "a number, in Hz", hint: "Frequency is the inverse of the period.", why: "f = 1/T", intro: "Here is a new one.", ...o });
      const script0 = script;
      script = (b, i) => (/write ONE exercise/.test(systemOf(b)) ? GEN({ topic: "Pulleys", question: "A 5 kg mass on a 30 degree frictionless slope is tied by a string over a pulley to a 2 kg hanging mass. What is the acceleration in m per second squared? Use g = 10.", answer: "0", check: "(5*10*sin(30) - 2*10)/(5+2)", format: "a number", intro: "Here is something new: connected masses." }) : script0(b, i));
      calls = [];
      const rd = await runTutorTurn({ ...base, board: [], problems: [car], message: "no but not same idea just totally different", history: [{ role: "user", text: "alright new problem now" }, { role: "assistant", text: "Let's test that idea again." }] });
      check("'totally different' after a car problem: the tutor is told, and the new problem (a different setting) lands in the widget with a verified key and a fresh worksheet header", /TOTALLY DIFFERENT/.test(JSON.stringify(calls[0].messages)) && rd.problems.length === 1 && /pulley/.test(rd.problems[0].question) && /^0\.7/.test(String(rd.problems[0].answer)) && rd.board.some((e) => e.kind === "focus" && /Pulleys/.test(e.text)));
    }
    {
      const { generateProblem, difficultyFrom } = await import("../server/tutorTurn/problemGen.ts");
      const tok = () => ({ in: 0, out: 0, cachedIn: 0 });
      const rec = (o) => ({ at: "x", move: "elicit", support: 1, intent: "answer", diagnosis: "none", words: 10, studentWords: 5, repaired: false, ms: 1, ...o });
      check("difficulty follows what they just did: up after success alone, down after two misses, otherwise at their level", difficultyFrom([rec({ verdict: "correct" }), rec({ verdict: "correct" })]) === "harder" && difficultyFrom([rec({ verdict: "incorrect" }), rec({ verdict: "incorrect" })]) === "easier" && difficultyFrom([rec({}), rec({ verdict: "correct", support: 4 })]) === "at_level");
      const good = { topic: "Sound", question: "A tuning fork vibrates 440 times per second. What is its period in milliseconds?", answer: "2.3", check: "1000/440", format: "a number, in ms", hint: "Period is 1 over frequency.", why: "T = 1/f", intro: "Let's try a different kind of wave." };
      let seen = [];
      script = (b) => { seen.push(b); return good; };
      let g = await generateProblem({ subject: "Physics", topic: "Waves", level: "DP1, IB Diploma, Physics HL", difficulty: "harder", kind: "compute", used: ["A pendulum swings 20 times in 30 s. What is its frequency?"], lang: "en", ask: "another one" }, tok());
      const userMsg = String(seen[0].messages[1].content);
      check("the generator is told the subject, topic, level, difficulty, kind and what is already used", /Subject: Physics/.test(userMsg) && /Topic: Waves/.test(userMsg) && /DP1, IB Diploma, Physics HL/.test(userMsg) && /HARDER/.test(userMsg) && /calculation/.test(userMsg) && /pendulum swings 20 times/.test(userMsg));
      check("the exercise comes back ready for the widget, with the lead-in sentence and a title", !!g && /tuning fork/.test(g.input.question) && g.intro === "Let's try a different kind of wave." && g.topic === "Sound");
      script = (b, i) => (i === 0 ? { ...good, answer: "9", check: "1000/440" } : good);
      g = await generateProblem({ subject: "Physics", topic: "Waves", difficulty: "at_level", kind: "compute", used: [], lang: "en" }, tok());
      const { makeProblem } = await import("../server/claude.ts");
      check("a wrong answer key is overruled by the code-evaluated check (never trusted)", /^2\.3/.test(String(makeProblem(g.input, true).problem?.answer)));
      let n = 0;
      script = () => (n++ === 0 ? { ...good, question: "A pendulum swings 20 times in 30 s. What is its frequency in hertz?", answer: "0.67", check: "20/30" } : good);
      g = await generateProblem({ subject: "Physics", topic: "Waves", difficulty: "at_level", kind: "compute", used: ["A pendulum swings 20 times in 30 s. What is its frequency?"], lang: "en" }, tok());
      check("an exercise that repeats one already used gets one corrective retry and the new one is returned", n === 2 && /tuning fork/.test(g.input.question));
      script = () => ({ question: "x" });
      check("a generator that keeps failing returns null so the caller falls back, never a broken exercise", (await generateProblem({ subject: "Physics", difficulty: "at_level", kind: "any", used: [], lang: "en" }, tok())) === null);
      // the full turn: asked for an exercise → the model only introduces it, the app writes it at their level
      const turnJson = T({ heard: "wants one", intent: "chat", diagnosis: { status: "none" }, move: "practice", support: 1, speech: ["A cyclist covers 120 metres in 8 seconds. What is the speed?"], board: [], expects: "value" });
      let genPrompt = "";
      script = (b) => { if (/write ONE exercise/.test(systemOf(b))) { genPrompt = String(b.messages[1].content); return good; } return turnJson; };
      calls = [];
      const out = await runTutorTurn({ ...base, message: "give me another one", problems: [], board: [], objectives: [{ id: "o", label: "Wave speed and period", done: false }], context: { subject: "Physics", profile: { yearLevel: "DP1", track: "ib", courses: ["Physics HL"], about: "", preferences: [], people: [], projects: [], sessions: [] } } });
      check("asked for an exercise: it lands in the answer widget at their level and topic, and the spoken problem text is replaced by the lead-in", out.problems.length === 1 && /tuning fork/.test(out.problems[0].question) && !/cyclist|120 metres/.test(out.reply) && /different kind of wave/.test(out.reply) && /Wave speed and period/.test(genPrompt) && /DP1/.test(genPrompt));
      // a problem that already exists goes through the widget with a solver-verified key
      script = (b) => (/write ONE exercise/.test(systemOf(b)) ? good : T({ heard: "wants the problem on the board", intent: "write_my_work", diagnosis: { status: "none" }, move: "elicit", support: 1, speech: ["What is the first force?"], board: [], expects: "value" }));
      const stated2 = "A 5 kg mass on a 30 degree frictionless slope is tied by a string over a pulley to a 2 kg hanging mass. What is the acceleration?";
      const solved = { ...sol, statement: stated2, focusKey: "k", value: 0.71, finalAnswer: "0.71 m s^-2", verified: true };
      const wb = await runTutorTurn({ ...base, board: [], problems: [], solution: solved, message: "write problem on board", history: [{ role: "user", text: "new problem" }, { role: "assistant", text: "Let's try this. " + stated2 }] });
      check("'write the problem on the board' puts the existing problem in the widget with a code-verified key", wb.problems.length === 1 && /pulley/.test(wb.problems[0].question) && /^0\.7/.test(String(wb.problems[0].answer)));
    }
    {
      const { wantsMoreExercises, difficultyAsked } = await import("../server/tutorTurn/intents.ts");
      check("the one-tap chips ('Got it! Give me another to try', 'Give me a harder one') ask for a new exercise; a harder/easier ask sets the difficulty", wantsMoreExercises("Got it! Give me another to try.") && wantsMoreExercises("Give me a harder one.") && !wantsMoreExercises("I'm lost — can we go smaller?") && difficultyAsked("Give me a harder one.") === "harder" && difficultyAsked("something easier please") === "easier" && difficultyAsked("another one") === null);
    }
    {
      const { proseEquation } = await import("../server/tutorTurn/verify.ts");
      const { repairLatex } = await import("../shared/mathText.ts");
      const { cantSeeProblem } = await import("../server/tutorTurn/intents.ts");
      check("a board 'equation' with words on a side is caught (the line '4 x 10 x sin(25) - 3 x 10 = pull down - 30'); real maths and \\text units are not", proseEquation("4 \\times 10 \\times \\sin(25^\\circ) - 3 \\times 10 = pull down - 30") && !proseEquation("$a = \\frac{Mg\\sin\\theta - mg}{M+m}$") && !proseEquation("$F = 450\\text{ N}$") && !proseEquation("v = 15 m/s"));
      check("a second note of the same kind on one line, or a note saying the same thing, is dropped; a different kind is allowed", (() => {
        const bd = [{ id: "L1", text: "$a = 1$", kind: "formula", at: "x" }, { id: "N1", text: "net force driving both masses", kind: "annotation", targetId: "L1", tone: "focus", at: "x" }];
        const base2 = { message: "x", theirWords: [], board: bd, problems: [], fr: false };
        const again = applyOps([{ op: "mark", cue: 0, target: "L1", note: "net force driving the whole system" }], base2);
        const diff = applyOps([{ op: "mark", cue: 0, target: "L1", note: "check the sign", tone: "error" }], base2);
        return again.board.length === 0 && diff.board.length === 1; })());
      check("boards saved with the swallowed backslash heal even after the tab became a space", repairLatex("F_ extresistive = kv^2") === "F_\\text{resistive} = kv^2" && repairLatex("P = F_{total} imes v") === "P = F_{total} \\times v" && repairLatex("an imes word") === "an imes word");
      check("'i dont see anything', 'what is questions asking', 'which question' mean they can't see the problem", cantSeeProblem("i dont see anything") && cantSeeProblem("what is the question asking") && cantSeeProblem("which question") && !cantSeeProblem("I see, so it is 5"));
    }
    {
      const { verifyTurn } = await import("../server/tutorTurn/verify.ts");
      const used = ["A car of mass 1000 kg rolls down a 10 degree slope and the resistive force is 2 v squared. At what speed does it stop accelerating?"];
      const t = { speech: ["That's it.", "Now let's look at the car problem on the board: it's rolling down a 10 degree slope with a resistive force of F = 2 v squared.", "When the car stops accelerating, what is the net force acting on it?"], move: "elicit", board: [], heard: "", intent: "other", diagnosis: { status: "none" }, support: 1, expects: "open" };
      const issues = verifyTurn(t, { message: "upwards", history: [], board: [], problems: [], policy: { maxSupport: 5, allowed: [], reason: "" }, wants: {}, said: [], discussion: false, usedExercises: used });
      check("dragging an old problem back into the conversation after the current one is solved is caught", issues.some((i) => i.code === "repeat_exercise"));
    }
    script = () => ({ fail: true });
    r = await runTutorTurn({ ...base, message: "hello?" });
    check("the model being down is an error for the route to report — never a made-up reply", r.error === true && !r.reply);
  } finally {
    globalThis.fetch = realFetch;
  }
}
