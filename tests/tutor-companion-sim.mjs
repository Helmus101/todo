// The learning-companion layer of the tutor: a verified hidden solution (server/solver.ts), the teaching state
// (help given, stuck streak), evidence for the student model, a board that only holds what the problem needs, and
// figures drawn to scale (INCLINE_ON_BOARD). Real loop, scripted model (fetch intercepted for api.deepseek.com).
process.env.DEEPSEEK_API_KEY ||= "sim-key";
delete process.env.GEMINI_API_KEY;
const { runTutorTurn, nextTeachingState, teachingBlock, evidenceKindFor, reachedSolutionSteps, statesFinalAnswer, relevantToFocus, parsePlan, tutorTools } = await import("../server/tutor.ts");
const { toSolution, solveProblem, solutionBlock, focusKeyOf, isNewProblem } = await import("../server/solver.ts");
const { buildInclineScene } = await import("../shared/inclineScene.ts");

let script = () => ({ content: "" });
let calls = [];
const realFetch = globalThis.fetch;
const fake = async (url, init) => {
  if (!String(url).includes("api.deepseek.com")) return realFetch(url, init);
  const body = JSON.parse(init.body);
  calls.push(body);
  const out = script(body, calls.length - 1) || { content: "" };
  const message = { role: "assistant", content: out.content ?? "", ...(out.tool_calls ? { tool_calls: out.tool_calls.map((t, i) => ({ id: `c${calls.length}_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}) };
  return new Response(JSON.stringify({ id: "s", object: "chat.completion", model: "s", choices: [{ index: 0, message, finish_reason: out.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
};
const tc = (name, args) => ({ name, args });
const sys = (b) => String(b.messages.find((m) => m.role === "system")?.content || "");
const lastUser = (b) => String([...b.messages].reverse().find((m) => m.role === "user")?.content || "");
const truckQ = "A 900 kg truck climbs a 12° slope at a constant 10 m/s against 360 N of friction, accelerating at 0.4 m/s². What power (in W) does the engine deliver?";
const truckJson = { final_answer: "25538 W", check: "(900*9.8*sind(12)+900*0.4+360)*10", steps: [
  { idea: "weight component along the slope", result: "mg sin 12° = 1833.8 N", check: "900*9.8*sind(12)" },
  { idea: "force for the acceleration", result: "ma = 360 N", check: "900*0.4" },
  { idea: "total driving force", result: "F = 2553.8 N", check: "900*9.8*sind(12)+900*0.4+360" },
  { idea: "power = force × speed", result: "P = 25538 W", check: "(900*9.8*sind(12)+900*0.4+360)*10" },
], key_idea: "the engine must supply every force opposing the motion", alternatives: ["energy per second: rate of PE gain + work against friction + KE gain"], mistakes: ["subtracting friction", "using sin(12) in radians"], skill: "power on an incline" };

export async function runTutorCompanionSim(check, section) {
  globalThis.fetch = fake;
  section("Tutor as a learning companion — verified solution, teaching state, memory, relevant one-font board, figures to scale");

  // ── the verified solution ──
  const sol = toSolution(truckQ, truckJson);
  check("a solution whose answer matches its own check is verified, with every step's number computed by code", sol.verified && Math.abs(sol.value - 25537.81) < 0.01 && Math.abs(sol.steps[2].value - 2553.78) < 0.01 && sol.skill === "power on an incline");
  check("a solution whose stated answer disagrees with its check is NOT verified", !toSolution(truckQ, { ...truckJson, final_answer: "40125 W" }).verified);
  check("a non-numeric answer (an essay point) needs no check", toSolution("Why did WWI start?", { final_answer: "alliance system + nationalism + the assassination as trigger", steps: [{ idea: "long-term causes" }] }).verified);

  script = (b, i) => i === 0 ? { content: JSON.stringify({ ...truckJson, final_answer: "40125 W" }) } : { content: "```json\n" + JSON.stringify(truckJson) + "\n```" };
  calls = [];
  const solved = await solveProblem(truckQ, "Physics");
  check("solveProblem re-solves once when code disagrees, and keeps the verified one", calls.length === 2 && solved.solution?.verified && solved.solution.finalAnswer === "25538 W" && /did not match your own check/.test(lastUser(calls[1])));
  script = () => ({ content: JSON.stringify({ ...truckJson, final_answer: "40125 W" }) });
  const stubborn = await solveProblem(truckQ);
  check("…and if the model insists, the code-computed value wins", stubborn.solution?.verified && Math.abs(Number(stubborn.solution.finalAnswer) - 25537.81) < 0.01);
  check("their own working with the problem's numbers is not a new problem; a different problem is", !isNewProblem("so 900 times 9.8 times sin 12 plus 360, find the force", sol) && isNewProblem("A 2 kg ball is thrown at 15 m/s at 40°. Find its range.", sol) && isNewProblem("anything 3 4", undefined));
  check("focusKeyOf: the same problem asked twice is one solve", focusKeyOf("A 900 kg truck…  $12^\\circ$") === focusKeyOf("a 900 kg truck… 12°".replace("12°", "$12^\\circ$")));

  check("the hidden solution block steers the tutor and says never reveal", /WORKED SOLUTION — FOR YOU ONLY \(verified by code\)/.test(solutionBlock(sol)) && /Never reveal it/.test(solutionBlock(sol)) && /subtracting friction/.test(solutionBlock(sol)));
  check("a student number matching a step is recognised (2553.8 → step 3; 25,538 → the final answer)", reachedSolutionSteps("so F is 2553.8", sol).includes(3) && reachedSolutionSteps("25,538 W", sol).includes(0) && !reachedSolutionSteps("2600", sol).length);
  check("statesFinalAnswer: the answer counts, a given that equals nothing doesn't, small answers only as '= 4'", statesFinalAnswer("that comes to 25,537.8 W", sol) && !statesFinalAnswer("the truck is 900 kg", sol) && statesFinalAnswer("so x = 4", { ...sol, value: 4, statement: "3x + 7 = 19" }) && !statesFinalAnswer("step 4 of 6", { ...sol, value: 4, statement: "3x + 7 = 19" }));

  // ── the turn uses it ──
  script = (b, i) => i === 0 ? { content: '<plan>{"diagnosis":"computational","action":"probe","help_level":1}</plan>Hm, so the power is 25,538 W — does that make sense?' } : { content: '<plan>{"diagnosis":"none","action":"probe","help_level":1}</plan>Nice set-up. What force does the engine have to supply?' };
  calls = [];
  let r = await runTutorTurn({ history: [{ role: "user", text: truckQ }, { role: "assistant", text: "What's your plan?" }], message: "I'd find the force first", board: [], problems: [], objectives: [], context: {}, lang: "en", solution: sol });
  check("the worked solution is in the prompt, the reply never states its final answer", /WORKED SOLUTION/.test(sys(calls[0])) && /gives away the answer/.test(lastUser(calls[1])) && !/25,?538/.test(r.reply) && r.plan?.action === "probe");
  script = () => ({ content: "Let's check that multiplication again — try 900 × 9.8 × sin(12°) + 360 + 360." });
  calls = [];
  r = await runTutorTurn({ history: [], message: "so F = 2553.8 N", board: [], problems: [], objectives: [], context: {}, lang: "en", solution: sol });
  check("a student number that IS a solution step is confirmed by code, never sent back for a redo", /VERIFIED BY CODE: the number they just gave matches step 3/.test(sys(calls[0])) && /that's right/i.test(r.reply));

  // ── teaching state ──
  check("parsePlan reads the hidden plan leniently", parsePlan('<plan>{"diagnosis":"conceptual","action":"explain","help_level":7}</plan>x')?.helpLevel === 4 && parsePlan("<plan>nope</plan>") === undefined);
  let st = nextTeachingState(undefined, { message: "I don't know" });
  st = nextTeachingState(st, { message: "no idea honestly", plan: { action: "hint", helpLevel: 2 } });
  check("two stuck turns → stuck streak 2, and the block tells the tutor to explain directly", st.stuckStreak === 2 && /Explain the missing idea directly/.test(teachingBlock(st)));
  const st2 = nextTeachingState(st, { message: "2553.8", verdict: "correct", plan: { action: "confirm", helpLevel: 3 } });
  check("a code-verified right step resets the streak and drops the help level", st2.stuckStreak === 0 && st2.helpLevel === 1 && /moving/.test(teachingBlock(st2)));
  check("a wrong exercise result counts as stuck", nextTeachingState(undefined, { message: '[Exercise] I answered "12" — marked wrong (try #1).' }).stuckStreak === 1);

  // ── memory: only code-verified evidence ──
  check("evidence: right with no help = solved-unaided; after hints = solved-after-hint; after an explanation = solved-after-explanation; wrong = mistake; nothing verified = nothing",
    evidenceKindFor({ message: '[Exercise] I answered "25538" — marked right (try #1).', helpLevel: 0 }) === "solved-unaided" &&
    evidenceKindFor({ message: "2553.8", verdict: "correct", helpLevel: 2 }) === "solved-after-hint" &&
    evidenceKindFor({ message: "x", reachedFinal: true, helpLevel: 4 }) === "solved-after-explanation" &&
    evidenceKindFor({ message: "b = 3", verdict: "incorrect", helpLevel: 0 }) === "mistake" &&
    evidenceKindFor({ message: "I think it's about forces", helpLevel: 0 }) === null);

  // ── the board ──
  check("a board line about something else is refused; one about the problem is kept", !relevantToFocus("Photosynthesis needs sunlight and chlorophyll", [truckQ]) && relevantToFocus("$F = mg\\sin 12^\\circ + 360$", [truckQ]) && relevantToFocus("anything", []));
  script = (b, i) => i === 0
    ? { tool_calls: [tc("WRITE_TO_BOARD", { text: "Fun fact: photosynthesis converts sunlight into chemical energy", kind: "insight" }), tc("WRITE_TO_BOARD", { text: "Truck: 900 kg, slope 12°, friction 360 N", kind: "given" })] }
    : { content: "What's the first force you'd look at?" };
  calls = [];
  r = await runTutorTurn({ history: [{ role: "user", text: truckQ }], message: "ok", board: [], problems: [], objectives: [], context: {}, lang: "en", solution: sol });
  check("…in a real turn: the off-topic line bounces, the givens land", r.board.length === 1 && /900 kg/.test(r.board[0].text) && /isn't about the problem/.test(calls[1].messages.filter((m) => m.role === "tool").map((m) => m.content).join(" ")));

  script = (b, i) => i === 0
    ? { tool_calls: [tc("SVG_ON_BOARD", { caption: "slope", svg: '<svg viewBox="0 0 400 200"><line x1="0" y1="200" x2="400" y2="120" stroke="black"/><text x="40" y="190">12°</text></svg>' }), tc("INCLINE_ON_BOARD", { angle: 12, forces: ["weight", "normal", "friction", "applied"], motion: "up", labels: { friction: "360 N", applied: "F = ?" } })] }
    : { content: "Look at the figure — which forces fight the motion?" };
  calls = [];
  r = await runTutorTurn({ history: [{ role: "user", text: truckQ }], message: "can you draw it", board: [], problems: [], objectives: [], context: {}, lang: "en", solution: sol });
  const toolOut = calls[1].messages.filter((m) => m.role === "tool").map((m) => m.content).join(" ");
  check("a hand-drawn SVG with an angle is refused (draw to scale), INCLINE_ON_BOARD draws it", /must be drawn to scale/.test(toolOut) && r.board.length === 1 && r.board[0].kind === "svg" && /KaTeX_Main/.test(r.board[0].svg));
  check("the tutor is offered INCLINE_ON_BOARD, and SVG_ON_BOARD is described as qualitative only", tutorTools(false).some((t) => t.name === "INCLINE_ON_BOARD") && /QUALITATIVE picture only/.test(tutorTools(false).find((t) => t.name === "SVG_ON_BOARD").description));

  // ── the incline figure is geometrically exact ──
  for (const angle of [8, 12, 30, 45]) {
    const fig = buildInclineScene({ angle, forces: ["weight", "normal", "components"] });
    const m = /M ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+) Z/.exec(fig.svg);
    const [ax, ay, , , cx, cy] = m.slice(1).map(Number);
    const drawn = (Math.atan2(ay - cy, cx - ax) * 180) / Math.PI;
    // the normal arrow is perpendicular to the slope; the weight arrow is vertical
    const lines = [...fig.svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" stroke="(#[0-9A-F]+)"/g)].map((l) => ({ dx: l[3] - l[1], dy: l[4] - l[2], c: l[5] }));
    const normal = lines.find((l) => l.c === "#2563EB"), weight = lines.find((l) => l.c === "#DC2626" && Math.abs(l.dx) < 0.5);
    const slope = { x: Math.cos((angle * Math.PI) / 180), y: -Math.sin((angle * Math.PI) / 180) };
    const dot = (normal.dx * slope.x + normal.dy * slope.y) / Math.hypot(normal.dx, normal.dy);
    check(`incline at ${angle}°: slope drawn at ${drawn.toFixed(2)}°, normal ⟂ slope, weight vertical`, Math.abs(drawn - angle) < 0.1 && Math.abs(dot) < 0.01 && !!weight && weight.dy > 0);
  }
  check("the incline refuses a nonsense angle", "error" in buildInclineScene({ angle: 95 }));
  globalThis.fetch = realFetch;
}
