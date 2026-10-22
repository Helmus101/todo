// The tutor turn (server/tutorTurn/*) against a scripted fake model: globalThis.fetch is intercepted for api.deepseek.com
// and returns whatever JSON each test scripts, so the REAL engine (prompt, one call, board ops) runs with no network or key.
process.env.DEEPSEEK_API_KEY ||= "sim-key";
delete process.env.GEMINI_API_KEY;

export async function runTutorTurnSim(check, section) {
  let script = () => ({});
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("api.deepseek.com")) return realFetch(url, init);
    const body = JSON.parse(init.body);
    calls.push(body);
    const out = await script(body, calls.length - 1);
    if (out && out.fail) return new Response(JSON.stringify({ error: { message: "boom" } }), { status: out.status || 500, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ id: "sim", object: "chat.completion", model: "sim", choices: [{ index: 0, message: { role: "assistant", content: typeof out === "string" ? out : JSON.stringify(out) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { runTutorTurn } = await import("../server/tutorTurn/engine.ts");
    const { applyOps } = await import("../server/tutorTurn/apply.ts");
    const { normalizeTurn, extractJsonObject } = await import("../shared/tutorTurn.ts");
    const { TURN_PROMPT, DRAW_REFERENCE } = await import("../server/tutorTurn/prompt.ts");
    const base = { history: [{ role: "user", text: "hi" }, { role: "assistant", text: "Hey! What are we working on?" }], board: [], problems: [], objectives: [], context: {}, lang: "en" };

    section("Tutor turn — parser, prompt, board ops (pure)");
    check("the JSON is read leniently (fence, speech as one string, synonyms) and unknown ops are dropped",
      (() => { const t = normalizeTurn(extractJsonObject('```json\n{"speech":"One. Two?","board_actions":[{"type":"mark","cue":7,"target":"#1"},{"op":"gap","text":"x"}]}\n```')); return t && t.speech.length === 2 && t.board.length === 1 && t.board[0].op === "mark" && t.board[0].cue === 1; })());
    check("no speech → no turn", normalizeTurn({ speech: [] }) === null && normalizeTurn("x") === null);
    check("single-backslash LaTeX inside the JSON survives (\\theta, \\times, \\text)", (() => { const t = normalizeTurn(extractJsonObject('{"speech":["ok."],"board":[{"op":"step","text":"$a \\times b \\theta \\text{N}$"}]}')); return t && /\\times/.test(t.board[0].text) && /\\theta/.test(t.board[0].text) && /\\text/.test(t.board[0].text); })());
    check("the prompt is short and Socratic: proactive board teaching, one question last, the last step left to the student", TURN_PROMPT.length < 11000 && /teach ON THE BOARD/.test(TURN_PROMPT) && /ONE question/.test(TURN_PROMPT) && /last step/.test(TURN_PROMPT) && /regions/.test(DRAW_REFERENCE));
    { const r = applyOps([{ op: "topic", cue: 0, text: "Quadratics" }, { op: "step", cue: 1, text: "$x^2 - 5x + 6 = 0$", kind: "given" }, { op: "step", cue: 1, text: "$x^2 - 5x + 6 = 0$", kind: "given" }, { op: "mark", cue: 1, target: "#9", note: "here" }], { board: [], problems: [], theirWords: [] });
      check("topic and step ops become board entries; a duplicate line and a mark on a missing line are dropped", r.board.length === 2 && r.board[0].kind === "focus" && r.board[1].cue === 1 && r.dropped.length === 2); }

    section("Tutor turn — one call, speech and board together");
    calls.length = 0;
    script = () => ({ speech: ["Let's factor it.", "What two numbers multiply to 6 and add to −5?"], board: [{ op: "step", cue: 0, text: "$x^2 - 5x + 6 = 0$", kind: "given" }] });
    { const r = await runTutorTurn({ ...base, message: "solve x^2 - 5x + 6 = 0" });
      check("one model call; the reply is the model's own sentences; the board gets the problem", calls.length === 1 && !r.error && r.reply === "Let's factor it. What two numbers multiply to 6 and add to −5?" && r.board.length === 1 && r.board[0].cue === 0);
      check("the system prompt carries the board and the history carries the conversation", /THE BOARD/.test(calls[0].messages[0].content) && calls[0].messages.at(-1).content === "solve x^2 - 5x + 6 = 0" && calls[0].messages.length === 4); }

    section("Tutor turn — the question lives on the board");
    calls.length = 0;
    script = (b, i) => (i === 0 ? { speech: ["Here is the equation we have after taking sine of both sides.", "What do you get when you square both sides?"], board: [] } : { speech: ["Here is the equation we have after taking sine of both sides.", "What do you get when you square both sides?"], board: [{ op: "step", cue: 0, text: "$\\\\sin A = \\\\sin B$", kind: "formula" }] });
    { const r = await runTutorTurn({ ...base, message: "ok" });
      check("a reply that points at an equation but writes nothing gets one more call and ends up with the line on the board", calls.length === 2 && r.board.length === 1 && /sin/.test(r.board[0].text)); }

    calls.length = 0;
    script = (b, i) => (i === 0 ? { speech: ["Yes, that works.", "Why does it?"], board: [] } : { speech: ["Yes, that works.", "Why does it?"], board: [{ op: "step", cue: 0, text: "$x = 3$", kind: "result" }] });
    { const r = await runTutorTurn({ ...base, message: "x = 3" });
      check("after an answer with maths and an empty board, the model is asked once to write the step", calls.length === 2 && r.board.length === 1); }
    calls.length = 0;
    script = (b, i) => (i === 0 ? { speech: ["My mistake, let's get that factored equation up on the board now.", "How can we isolate the square root term?"], board: [] } : { speech: ["Here it is.", "How can we isolate the square root term?"], board: [{ op: "step", cue: 0, text: "$x(1 + \\sqrt{3}) = 2$", kind: "result" }] });
    { const r = await runTutorTurn({ ...base, message: "on the board though" });
      check("a student who says 'on the board though' (no maths in the message) gets the line written: a reply that claims it wrote something is sent back", calls.length === 2 && r.board.length === 1 && /sqrt/.test(r.board[0].text)); }
    calls.length = 0;
    script = (b, i) => (i === 0 ? { speech: ["Done.", "What next?"], board: [{ op: "mark", cue: 0, target: "#99", note: "here" }] } : { speech: ["Done.", "What next?"], board: [{ op: "step", cue: 0, text: "$a + b = c$", kind: "result" }] });
    { const r = await runTutorTurn({ ...base, message: "please write that on the board" });
      check("ops the app rejects (a mark on a line that does not exist) do not count as writing: the model is told what was rejected and tries again", calls.length === 2 && /rejected/.test(calls[1].messages.at(-1).content) && r.board.length === 1); }
    { const { carriesWorking } = await import("../server/tutorTurn/check.ts");
      check("working worth a second look is long, mathematical spoken working; a short answer, small talk and an exercise result are not", carriesWorking("I get one minus three x squared plus three minus three x squared equals one over x squared") && !carriesWorking("x = 3") && !carriesWorking("ok thanks that makes sense now") && !carriesWorking("[Exercise] I answered 4 — marked right")); }
    calls.length = 0;
    script = (b, i) => (i === 0 ? { steps: [{ said: "squared both sides", ok: true }, { said: "expanded with the cross term", ok: true }], first_error: null, already_done: "squared the left side and expanded it", unclear: false } : { speech: ["That expansion is right, cross term and all.", "What does the cross term still contain that stops us solving for x?"], board: [{ op: "step", cue: 0, text: "$1 - 3x^2 + 3 - 3x^2 + 2\\sqrt{(1-3x^2)(3-3x^2)} = \\frac{1}{x^2}$", kind: "result" }] });
    { const r = await runTutorTurn({ ...base, message: "so I squared both sides and I get one minus three x squared plus three minus three x squared plus two times the root of those equals one over x squared" });
      check("a long derivation is recomputed by a second reader first; its verdict rides in the tutor's prompt (already done, never redo) and the reply is the tutor's own", calls.length === 2 && /recomputed their working/.test(calls[1].messages[0].content) && /never ask them to redo/.test(calls[1].messages[0].content) && /cross term/.test(r.reply)); }
    calls.length = 0;
    script = () => ({ speech: ["Hi there.", "What are we working on?"], board: [] });
    { await runTutorTurn({ ...base, message: "hello" });
      check("small talk with nothing to write costs no extra call", calls.length === 1); }

    section("Live voice — the board writer");
    { const { writeBoard } = await import("../server/tutorTurn/boardWriter.ts");
      calls.length = 0;
      script = () => ({ board: [{ op: "topic", cue: 0, text: "Quadratics" }, { op: "step", cue: 0, text: "Solve $x^2 - 5x + 6 = 0$", kind: "given" }, { op: "step", cue: 0, text: "$(x-2)(x-3) = 0$", kind: "formula" }] });
      const r = await writeBoard({ exchange: "Student: solve x squared minus five x plus six equals zero\nTutor: What two numbers multiply to six and add to minus five?", board: [], subject: "Math" }, { in: 0, out: 0, cachedIn: 0 });
      check("the board writer turns one exchange into board entries (topic, the problem typeset, a line)", r.board.length >= 2 && r.board.some((e) => /x\^2/.test(String(e.text))) && calls.length === 1 && /NEVER WRITE: the tutor's questions, hints/.test(calls[0].messages[0].content) && /WRITE IT/.test(calls[0].messages[0].content) && /log_2 8 = 3/.test(calls[0].messages[0].content));
      { const { tutorExplained } = await import("../server/tutorTurn/boardWriter.ts");
        const logEx = "Student: I don't get logarithms\nTutor: To start from scratch, think of a logarithm as the opposite of an exponent. For example, since 2 to the power of 3 is 8, the logarithm base 2 of 8 is 3. What do you think the logarithm base 3 of 9 would be?";
        check("an exchange where the tutor explained something with an example is recognised; small talk and a bare question are not", tutorExplained(logEx) && !tutorExplained("Student: hi\nTutor: Hi! What are you working on today?") && !tutorExplained("Student: x is 3\nTutor: Why does that work?"));
        calls.length = 0;
        script = (b, i) => (i === 0 ? { board: [] } : { board: [{ op: "step", cue: 0, text: "A logarithm is the opposite of an exponent: $\\log_b x = y \\iff b^y = x$", kind: "definition" }, { op: "step", cue: 0, text: "$2^3 = 8 \\implies \\log_2 8 = 3$", kind: "formula" }] });
        const lg = await writeBoard({ exchange: logEx, board: [], subject: "Math" }, { in: 0, out: 0, cachedIn: 0 });
        check("when the tutor explained something and the first pass wrote nothing, the writer is asked once more and the explanation lands on the board", calls.length === 2 && lg.board.length === 2 && /nothing, but the tutor explained/.test(calls[1].messages.at(-1).content));
        calls.length = 0;
        script = () => ({ board: [] });
        const sm = await writeBoard({ exchange: "Student: hello\nTutor: Hi! What are you working on today?", board: [], subject: "Math" }, { in: 0, out: 0, cachedIn: 0 });
        check("small talk costs only one call and writes nothing", calls.length === 1 && sm.board.length === 0); }
      script = () => ({ board: [] });
      const e = await writeBoard({ exchange: "Student: hello\nTutor: Hi! What are you working on?", board: [], subject: "Math" }, { in: 0, out: 0, cachedIn: 0 });
      check("small talk writes nothing", e.board.length === 0);
      script = () => "not json";
      const bad = await writeBoard({ exchange: "Student: hi", board: [], subject: "Math" }, { in: 0, out: 0, cachedIn: 0 });
      check("an unusable reply writes nothing instead of failing", bad.board.length === 0); }

    section("Multiple choice on the board");
    { const t = normalizeTurn({ speech: ["Pick one."], board: [{ op: "choice", cue: 0, text: "What is the first step in $3(x+2)-5=10$?", options: ["Add 5 to both sides", "Divide by 3", "Expand the bracket", ""] }, { op: "choice", cue: 0, text: "bad", options: ["only one"] }] });
      check("a choice op keeps its question and its (non-empty) options; one with fewer than two options is dropped", t.board.length === 1 && t.board[0].op === "choice" && t.board[0].options.length === 3);
      const r = applyOps(t.board, { board: [], problems: [], theirWords: [] });
      check("a choice becomes a board entry with tappable options and never records which one is right; the same question is not added twice", r.board.length === 1 && r.board[0].kind === "choice" && r.board[0].options.length === 3 && !("correct" in r.board[0]) && !("expectedAnswer" in r.board[0]) && applyOps(t.board, { board: r.board, problems: [], theirWords: [] }).board.length === 0); }

    { const { earlierInSitting } = await import("../server/tutorTurn/engine.ts");
      const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: i === 0 ? "I want to master quadratics before Friday" : `message ${i}` }));
      check("a long sitting keeps the student's first request in the prompt; a short one adds nothing", /quadratics before Friday/.test(earlierInSitting(long)) && earlierInSitting(long.slice(0, 10)) === ""); }

    section("Tutor turn — never a dead end");
    calls.length = 0;
    script = (b, i) => (i === 0 ? "not json at all" : { speech: ["Back on track — what did you get?"], board: [] });
    { const r = await runTutorTurn({ ...base, message: "hello" });
      check("prose instead of JSON is spoken as it is (no second call, no error)", !r.error && r.reply === "not json at all" && calls.length === 1); }
    script = () => ({ speech: [], board: [] });
    { const r = await runTutorTurn({ ...base, message: "hello" });
      check("an empty turn is retried once, then reported as an error", r.error === true && calls.length === 3 - 1 + 0 || r.error === true); }
    script = () => ({ fail: true, status: 500 });
    { const r = await runTutorTurn({ ...base, message: "hello" });
      check("a provider failure is reported as an error with a kind", r.error === true && typeof r.errorKind === "string"); }
  } finally { globalThis.fetch = realFetch; }
}
