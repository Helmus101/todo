import { toSpeakableText } from "../client/voice/useSpeechSynthesis.ts";
// The new tutor engine (server/tutor.ts) against a scripted fake model: globalThis.fetch is intercepted for
// api.deepseek.com, so the REAL turn loop, tools and guards run with no network and no key. It can't judge how
// a live model writes; it proves the few hard guarantees hold: no answer leaks, wrong arithmetic gets fixed,
// the board only takes maths that typesets and never a mishearing, one problem at a time, and the prompt
// carries the conversation first and the background second.
process.env.DEEPSEEK_API_KEY ||= "sim-key";
delete process.env.GEMINI_API_KEY;
const { detectSubject, backgroundBlock, TUTOR_PROMPT, leakedValue, wantsExercise, inventsProblemOnBoard, doubtsRightAnswer, misgradedExercise, harshOpener, computedGapKey, nextTeachingState, sendsBackToStatement, statesFormula, misstatesGiven, stripPraiseOpener, tutorTools, applyTool, delegatesChoice, statesStudyGoal, proposesPlan, planConsented, agreesWithoutChallenge, asksStudentToChoose, repeatsSolvedCalculation, needsExplanation, asksToRestart, plainRelationIn, EXPLAIN_BLOCK } = await import("../server/tutor.ts");
const { stripLeakedToolCallSyntax, textToolCalls } = await import("../server/ai/client.ts");
const { hideToolLeaks } = await import("../shared/toolLeak.ts");
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

export async function runTutorEngineSim(check, section) {
  section("Tutor engine (server/tutor.ts) — simple, Socratic, a few hard guards (real loop, scripted model)");

  const probs = [{ id: "p1", question: "Water content of a 125 g sample with dry mass 100 g?", answer: "0.25", createdAt: "" }];
  check("leakedValue: open problem answers count, solved ones don't", leakedValue("so it comes out at 0.25", "hm", [], probs) !== null && leakedValue("so it comes out at 0.25", "hm", [], [{ ...probs[0], solved: true }]) === null);
  check("no background at all → no empty BACKGROUND header", backgroundBlock({}) === "");

  check("the prompt is Socratic and subject-agnostic", /Never give the answer/.test(TUTOR_PROMPT) && /ANY SUBJECT/.test(TUTOR_PROMPT) && /another way/.test(TUTOR_PROMPT) && /independent thinker/.test(TUTOR_PROMPT));
  check("subject detection: explicit words win, keywords decide otherwise, nothing → undefined",
    detectSubject("j'ai un exo de physique sur les forces") === "Physics" && detectSubject("solve x² − 5x + 6 = 0") === "Math" &&
    detectSubject("why did the cold war start") === "History" && detectSubject("help me plan my essay on Shakespeare") === "English" && detectSubject("hi") === undefined);

  // Reported live: asked for a problem, Otto wrote "Car of mass 1000 kg climbs a hill of slope 10° at 15 m/s" and
  // "Required power = mgv sin(10°) = ?" as board text + a gap, instead of an exercise with an answer box.
  const carGiven = "Car of mass 1000 kg climbs a hill of slope $10^\\circ$ at a constant speed of 15 m/s.";
  check("wantsExercise / inventsProblemOnBoard", wantsExercise("give me another problem") && wantsExercise("interroge-moi") && wantsExercise("quiz me") && !wantsExercise("I'm stuck on this one") &&
    inventsProblemOnBoard("A 2 kg block on a 30° ramp", ["help with ramps"]) && !inventsProblemOnBoard("A 2 kg block on a 30° ramp", ["a 2 kg block on a 30 degree ramp"]) && !inventsProblemOnBoard("$E = mgh$", []));

  // "Never auto-derive equations or show which equations they need — ask them first."
  const carBoard = [{ id: "c1", at: "", kind: "given", text: "Car: $m = 1000$ kg, slope $10^\\circ$, $v = 15$ m/s. Find the power against gravity." }];
  check("equationsAhead: formulas count, givens/unknowns/their own lines don't",
    equationsAhead("$F = mg\\sin\\theta$", ["find F"]).length === 1 && equationsAhead("$m = 1000$ kg, $v = 15$ m/s", []).length === 0 &&
    equationsAhead("$b = ?$", []).length === 0 && equationsAhead("$\\tan 25^\\circ = \\frac{h}{b}$", ["tan 25 equals h over b"]).length === 0 &&
    equationsAhead("Yes, b = h/tan(25°) — now the other triangle.", ["b = h/tan(25°)"]).length === 0);
  check("doubtsRightAnswer leaves a genuinely wrong answer alone", doubtsRightAnswer("Check that again: $1000 \\times 9.8 \\times \\sin(10^\\circ) \\times 15$.", "5,526") === null);

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

  // Reported live: the student said "the force along the slope plus accelerating force minus 360" and Otto put the
  // whole substituted set-up on the board for them: "Total force = 900×9.8×sin(12°) + 900×0.4 + 360 = ?".
  const truck = [{ id: "pT", question: "A 900 kg truck accelerates at 0.4 m/s² up a 12° slope against 360 N of friction. Find the engine's force.", answer: "2553", createdAt: "" }];
  check("harshOpener catches French openers too", !!harshOpener("Attention, Willem : le frottement s'oppose au mouvement.") && harshOpener("Regardons le frottement.") === null);

  // Reported live: "It's already on the board, Willem — line 40. … what's 900 × 9.8 × sin(12°), what's 900 × 0.4,
  // and then add the 360?" — the board showed NO line numbers (and had no line 40), and the reply handed over the
  // substituted pieces to compute.
  const numbered = [
    { id: "l1", n: 1, at: "2026-10-10T10:00:00Z", kind: "given", text: "Truck: 900 kg, 12° slope, a = 0.4 m/s², friction 360 N" },
    { id: "l2", n: 2, at: "2026-10-10T10:01:00Z", kind: "summary", owner: "student", text: "F = gravity along slope + ma + friction" },
  ];
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
  check("stripPraiseOpener runs on the reply that ships", stripPraiseOpener("Spot on, Willem! What does that give you for v?") === "What does that give you for v?");

  check("statesFormula / misstatesGiven: a formula counts; a restated GIVEN that isn't in the problem is caught",
    statesFormula("Initial potential energy mgh turns into kinetic energy ½mv², so you get gh = ½v².") &&
    statesFormula("It's $W = F \\cdot d$ for a parallel force.") && !statesFormula("Look at line 3 — what do you notice?") &&
    misstatesGiven("Let's look at the problem on the board: a 3 kg box pulled by a force of 15 N.", ["A 3 kg box pulled up by 12 N"]) === "15" &&
    misstatesGiven("The problem says 12 N and friction of 2 N.", ["A 3 kg box pulled up by 12 N, friction 2 N"]) === null &&
    misstatesGiven("Let's look at the problem statement: 3 × 9.8 × sin(20°) = 10.06.", ["A 3 kg box, 20° incline"]) === null);
  const { wrapsUpUnasked: wu } = await import("../server/tutorAdapt.ts");
  check("'Let's wrap this up for now — great work!' counts as an unasked wrap-up", wu("You nailed it. Let's wrap this up for now — great work!", "yes it makes sense"));
  const mp = makeProblem({ question: "A 3 kg box is pulled up a 20° slope by 12 N with 2 N friction over 5 m; find the speed.", answer: "1.0", check: "sqrt(2*(12-2-3*9.8*sin(20*pi/180))*5/3)" }, true);
  check("a problem whose own check can't evaluate (impossible numbers: the pull can't beat gravity + friction) is refused with that reason", "error" in mp && /impossible|does not evaluate/.test(mp.error));

  // The tutor's board edits go through the validated action layer: its own lines can be corrected in place / taken off, the student's can't.
  const editBoard = [
    { id: "t1", at: "", kind: "formula", text: "$W_{net} = 5.52 \\times 4 = 22.08$", owner: "otto" },
    { id: "s1", at: "", kind: "result", text: "$F_{net} = 4.4$", owner: "student" },
  ];

  const { parsePlan: pp } = await import("../server/tutor.ts");
  const { solvedGapKey: sgk } = await import("../server/tutor.ts");
  check("a gap that states an equation for its unknown is SOLVED in code (2·9.8·3 = ½(400)x² ⟹ x = ? → 0.5422), so a correct 0.54 is never 'checked wrong'",
    Math.abs(sgk("$2 \\cdot 9.8 \\cdot 3 = \\frac{1}{2}(400)x^2 \\Longrightarrow x = ?$") - 0.542218) < 1e-5 && Math.abs(sgk("2·9.8·3 = ½(400)x² ⟹ x = ?") - 0.542218) < 1e-5 && sgk("3x + 1 = 10 ⟹ x = ?") === 3
    // "F = 5 ⟹ F = ?" states its own value, so the line solves to 5. It returned null only because the
    // solve keyed its value map by the RAW target ("F") while the compiler lowercases every identifier —
    // i.e. the same case bug that stopped EVERY uppercase unknown (P, Q, V, F…) from ever being solved.
    && sgk("F = 5 ⟹ F = ?") === 5
    && equivalent("0.54", String(sgk("2·9.8·3 = ½(400)x² ⟹ x = ?")), "x") === "correct" && equivalent("0.55", "0.542218", "x") === "incorrect");

  section("Critical-thinking partner: agreement is always followed by a challenge");

  section("Spec: proactive lesson plan, one canonical summary, rubric-graded concept answers");

  section("Explain mode — when they're lost, Otto teaches the step plainly and writes it (reported live: 'it doesn't explain')");

  section("Leaked tool-call plumbing never reaches the student (reported live: '#%%call:default_api:')");
  check("'#%%call:default_api:' is removed, on the server and on display", stripLeakedToolCallSyntax("#%%call:default_api:") === "" && hideToolLeaks("#%%call:default_api:") === "" && stripLeakedToolCallSyntax("Give it a go. #%%call:default_api:x") === "Give it a go.");
  check("a call written as NAME{json} still happens", textToolCalls('Try it. default_api:WRITE_TO_BOARD{"kind":"gap","text":"a = ?"}').some((c) => c.name === "WRITE_TO_BOARD" && c.args.text === "a = ?"));
  check("display cleanup removes NAME(…) with nested brackets and keeps the prose", hideToolLeaks("WRITE_TO_BOARD(gap, a=M+mg(Msinθ−m)=?)\n\nAh, let's look") === "Ah, let's look" && hideToolLeaks("## Heading\n50% done") === "## Heading\n50% done");
}
