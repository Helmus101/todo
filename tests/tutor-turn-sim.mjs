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
    check("apply: a mark points at a real line, keeps the part only when it's in the line, and carries its cue", (() => { const a = applyOps([{ op: "mark", cue: 2, target: "#2", style: "circle", part: "-T", tone: "focus", note: "the pull back" }, { op: "mark", cue: 0, target: "#2", style: "box", part: "zzz" }], actx); return a.board.length === 2 && a.board[0].markStyle === "circle" && a.board[0].markPart === "-T" && a.board[0].cue === 2 && !a.board[1].markPart && a.board[0].targetId === "s"; })());
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

    script = () => ({ fail: true });
    r = await runTutorTurn({ ...base, message: "hello?" });
    check("the model being down is an error for the route to report — never a made-up reply", r.error === true && !r.reply);
  } finally {
    globalThis.fetch = realFetch;
  }
}
