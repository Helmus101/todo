// ONE TUTOR TURN (the /tutor stage) — HeyAristotle-style, as one structured model call:
//
//   facts (code)  →  one JSON turn: interpretation · diagnosis · ONE move at a support level · speech · board ops
//                 →  verify (code: help within the limit, no answer given away, pointers real, intent honoured,
//                     one question, length, one visual, maths right)  →  at most ONE repair call  →  degrade in code
//                 →  apply the board ops (figures drawn to scale by code)  →  reply + board + a turn record
//
// What code knows before the model runs — is their step right, which solution step they've reached, did they
// answer the exercise in chat, how much help is allowed, what they're asking for — goes into the prompt as facts, so
// the model spends its one call on teaching. Nothing here substitutes a fixed sentence: every word the student
// reads is the model's own; code only removes what must not ship.
import type { BoardEntry, TaskObjective, TaskProblem, TutorSolution, TutorTeachingState } from "../../shared/types.ts";
import { MOVE_SUPPORT, normalizeTurn, extractJsonObject, salvageTurn, type TurnOutput } from "../../shared/tutorTurn.ts";
import { repairSpokenMath, spokenContextFrom, type SpokenRepair } from "../../shared/spokenMath.ts";
import { boardSurfaceBlock } from "../boardEvents.ts";
import { solutionBlock, solveProblem } from "../solver.ts";
import { createTutorChat, retryRequest, usageOf, OUT, nowBlock, rewriteReply, stepVerdictLine } from "../claude.ts";
import { asksWhy, asksToWrite, asksToDraw, voiceInputBlock, similarity, posesProblemInProse, studentProblemStatement } from "../tutorAdapt.ts";
import {
  backgroundBlock, objectivesBlock, solutionMatchLine, misgradedExercise, ownArithmeticLine, answeredInChat, wrongInChat,
  isDiscussionSubject, DISCUSSION_BLOCK, needsExplanation, asksToRestart, wantsExercise, reachedSolutionSteps,
  studentBoardLine, stripPraiseOpener, dropRepeatedName, stripMechanics, mentionsMechanics, affectOf,
  type TutorTurnInput, type TutorTurnResult, type TutorPlanLite,
} from "../tutor.ts";
import { TURN_PROMPT, VOICE_NOTE } from "./prompt.ts";
import { supportPolicy, asksForWorkedExample, adaptationLines, type Policy } from "./policy.ts";
import { verifyTurn, degradeTurn, acceptsBoardOffer, claimsBoard, sceneNounsIn, type Issue, type VerifyContext } from "./verify.ts";
import { applyOps } from "./apply.ts";
import { sessionGuide } from "./guide.ts";
import { asksToWriteProblem, wantsDifferent, problemStatement, wantsMoreExercises, difficultyAsked } from "./intents.ts";
import { generateProblem, difficultyFrom } from "./problemGen.ts";
import { exercisesSoFar, exercisesBlock, recentQuestionKinds, varietyLine, sameExercise } from "./exercises.ts";

const MAX_HISTORY = 14;
const STUCK = /\b(?:i (?:don'?t|do not) (?:know|get it|understand)|idk|no idea|i'?m (?:stuck|lost|confused)|not sure|je (?:ne )?sais pas|j'?sais pas|aucune idée|je suis (?:perdu|bloqué)e?|je comprends pas|help me|aide[- ]moi)\b/i;

/** The turn the app has already worked out, as a prompt block the model must respect. Exported for tests. */
export function factsBlock(f: { policy: Policy; verdict?: { gap: string; given: string; verdict: "correct" | "incorrect" }; solvedInChat?: string; wrongInChat?: boolean; wants: VerifyContext["wants"] & { explain: boolean }; teaching?: TutorTeachingState; affect: string; adapt?: string[] }): string {
  const lines = [
    `SUPPORT ALLOWED THIS TURN: up to level ${f.policy.maxSupport} (${f.policy.reason}). Allowed moves: ${f.policy.allowed.join(", ")}.`,
    f.verdict ? `THEIR STEP, CHECKED BY CODE: "${f.verdict.given}" for the open line "${f.verdict.gap}" is ${f.verdict.verdict === "correct" ? "RIGHT — credit exactly what was right" : "WRONG — find the first thing that's off; don't give the value"}.` : "",
    f.solvedInChat ? `THEY JUST ANSWERED THE OPEN EXERCISE IN CHAT AND IT IS RIGHT (code-checked): "${f.solvedInChat.slice(0, 160)}". Confirm it — never ask them to type it into the box — then deepen it (ask why it works or give a variation) before moving on.` : "",
    f.wrongInChat ? "Their number for the open exercise is WRONG (code-checked): look for the first slip, no new exercise." : "",
    f.wants.why ? "THEY ASKED WHY: give the real reason first, in plain words." : "",
    f.wants.explain && !f.wants.why ? "THEY NEED IT EXPLAINED (lost, asked to be shown, or stuck): teach the missing idea plainly and write it on the board as you say it, then hand back one small step." : "",
    f.wants.problemOnBoard ? "THEY ASKED YOU TO PUT THE PROBLEM ON THE BOARD: in THIS turn add a topic op, then the FULL problem statement (every given and the question) as a step of kind \"given\", then ask the first step. Don't ask another question instead." : "",
    f.wants.different ? "THEY WANT SOMETHING TOTALLY DIFFERENT: a new problem in a different situation and, if you can, a different idea from everything used so far — not a variation of the last one. Open a fresh worksheet with a topic op." : "",
    f.wants.write ? "THEY ASKED YOU TO WRITE THEIR WORKING: put their last step on the board as their own line (owner student)." : "",
    f.wants.restart ? "THEY ASKED TO START OVER: open a fresh worksheet (topic op), restate the givens, explain the first idea slowly." : "",
    f.wants.draw ? "THEY ASKED YOU TO DRAW / SHOW IT (or said yes to your offer): put it on the board in THIS turn with a draw op (a table op for a sign chart, grid or comparison) — never promise it and wait." : "",
    f.wants.exercise ? "THEY ASKED FOR AN EXERCISE: post one with a problem op." : "",
    f.affect === "frustrated" ? "They sound frustrated: a few warm words, a smaller step, a quick win." : f.affect === "unsure" ? "They sound unsure: ask for their reasoning before you confirm." : "",
    (() => { const open = (f.teaching?.misconceptions || []).filter((m) => !m.resolved); return open.length ? `Open misconceptions this session: ${open.map((m) => `"${m.label}"`).join("; ")} — test them with a fresh case before moving on.` : ""; })(),
  ...(f.adapt || []),
  ].filter(Boolean);
  return `\n\nFACTS FROM THE APP (trust these over your own reading):\n- ${lines.join("\n- ")}`;
}

/** The plan the rest of the app still reads (teaching state, evidence), mapped from the structured turn. */
function planOf(t: TurnOutput): TutorPlanLite {
  const action = ({ elicit: "probe", revoice: "probe", confirm: "confirm", focus: "probe", probe_why: "probe", practice: "practice", recap: "confirm", hint_concept: "hint", correct_error: "hint", hint_procedure: "hint", worked_step: "explain", explain: "explain", worked_example: "example" } as const)[t.move];
  const diagnosis = ({ correct: "none", partial: "procedural", misconception: "conceptual", slip: "computational", no_attempt: "prerequisite", unclear: "interpretive", none: "none" } as const)[t.diagnosis.status];
  return { action, diagnosis, helpLevel: Math.min(4, MOVE_SUPPORT[t.move]), ...(t.diagnosis.misconception ? { misconception: t.diagnosis.misconception } : {}) };
}

async function callTurn(messages: any[], tokens: TutorTurnResult["tokens"]): Promise<{ turn: TurnOutput | null; raw: string }> {
  const ask = async (json: boolean) => retryRequest(() => createTutorChat({ max_tokens: OUT.chat, temperature: 0.5, messages, ...(json ? { response_format: { type: "json_object" } } : {}) }, true), 2, 400);
  let res: any;
  // JSON mode first; a provider that rejects the parameter gets the same request without it (the prompt asks for JSON anyway).
  try { res = await ask(true); } catch (e: any) { if (Number(e?.status) === 400) res = await ask(false); else throw e; }
  const u = usageOf(res); tokens.in += u.in; tokens.out += u.out; tokens.cachedIn += u.cachedIn;
  const raw = String(res?.choices?.[0]?.message?.content || "");
  return { turn: normalizeTurn(extractJsonObject(raw)) ?? normalizeTurn(salvageTurn(raw)), raw };
}

export interface TurnExtras {
  /** The reply as sentences, in order — the board ops' cues index into this. */
  speech: string[];
  angle?: string;
  misconception?: string;
  move: string;
  support: number;
  intent: string;
  diagnosis: string;
  repaired: boolean;
  issues: string[];
  dropped: string[];
  ms: number;
  /** A wrong attempt, a stuck message or a diagnosed misconception this turn (drives "explain after struggle"). */
  struggled: boolean;
}

/** Both texts name scenario objects, and not one in common (a bicycle problem vs a car problem). */
function differentScene(a: string, b: string): boolean {
  const A = sceneNounsIn(a), B = sceneNounsIn(b);
  return A.length > 0 && B.length > 0 && !A.some((n) => B.includes(n));
}

/** The student re-stated the solved problem's own numbers (so the saved solution is still the right one). */
function statedAgain(message: string, statement: string): boolean {
  const nums = (t: string) => new Set(String(t).match(/\d+(?:[.,]\d+)?/g) || []);
  const a = nums(message), b = nums(statement);
  if (a.size < 2) return false;
  let hit = 0; for (const n of a) if (b.has(n)) hit++;
  return hit >= 2;
}

/** Spoken text that sets a problem: two or more numbers and a question (units spelled out count: "120 metres"). */
const statesAProblem = (t: string) => (t.match(/\d+(?:[.,]\d+)?/g) || []).length >= 2 && /\?/.test(t) && t.length >= 40;
const countWordsLite = (t: string) => t.split(/\s+/).filter(Boolean).length;

export async function runTutorTurn(input: TutorTurnInput): Promise<TutorTurnResult & { turn?: TurnExtras }> {
  const t0 = Date.now();
  const { message, history, board, problems, objectives, context, lang } = input;
  // WHAT THE PROBLEM IS RIGHT NOW, decided by code: the open exercise, else the last given/topic on the board. A saved
  // solution for some OTHER problem (a bicycle, an earlier question) must never steer this one.
  const focusText = [...problems].reverse().find((p) => !p.solved)?.question
    || [...board].reverse().find((b) => b.kind === "given" && b.text && b.text.split(/\s+/).length >= 12)?.text || "";
  // Only a full problem statement can contradict a saved solution (a short given like "M = 3 kg" never does).
  if (input.solution && focusText && focusText.split(/\s+/).length >= 8 && (similarity(input.solution.statement, focusText) < 0.12 || differentScene(input.solution.statement, focusText)) && !statedAgain(message, input.solution.statement)) input = { ...input, solution: undefined };
  const fr = lang === "fr";
  const result: TutorTurnResult & { turn?: TurnExtras } = { reply: "", board: [], problems: [], tokens: { in: 0, out: 0, cachedIn: 0 }, guardrailTripped: false };

  // ── Facts, by code ──
  const solvedNow = problems.filter((p) => answeredInChat(message, p));
  if (solvedNow.length) { for (const p of solvedNow) p.solved = true; result.solvedInChat = solvedNow.map((p) => p.id); }
  const wrongNow = !solvedNow.length && problems.some((p) => wrongInChat(message, p));
  const spokenRepair: SpokenRepair | null = input.spoken ? repairSpokenMath(message, spokenContextFrom([context.subject || "", ...board.map((b) => b.text || ""), ...problems.map((p) => p.question || "")])) : null;
  const problemOnBoard = asksToWriteProblem(message);
  const wants = { why: asksWhy(message), write: asksToWrite(message) && !problemOnBoard, problemOnBoard, different: wantsDifferent(message), restart: asksToRestart(message), exercise: wantsExercise(message) || wantsMoreExercises(message), explain: needsExplanation(message, input.teaching), draw: asksToDraw(message) || acceptsBoardOffer(message, history) };
  const verdict = input.stepVerdict?.verdict ?? (solvedNow.length ? "correct" : wrongNow ? "incorrect" : undefined);
  const policy = supportPolicy({ teaching: input.teaching, needsExplanation: wants.explain, asksWhy: wants.why, asksForWorkedExample: asksForWorkedExample(message), verdict });
  const discussion = isDiscussionSubject(context.subject, [message, ...history.slice(-4).map((h) => h.text)].join(" "));
  const affect = affectOf(message);
  const misgraded = misgradedExercise(message, input.solution);
  const usedExercises = exercisesSoFar({ history, problems, memory: context.memory, board });

  const system = TURN_PROMPT
    + (input.voiceMode ? VOICE_NOTE : "")
    + nowBlock()
    + backgroundBlock(context)
    + (discussion ? DISCUSSION_BLOCK : "")
    + objectivesBlock(objectives).replace(/SET_OBJECTIVES/g, "a plan op")
    + `\n\nTHE BOARD (margin numbers #n are what you point at)${boardSurfaceBlock(board, problems) || ": empty — open it with a topic op and the starting point."}`
    + (input.dueRetests?.length && history.length <= 1 ? `\n\nOPENING THE SITTING: last time you helped them with ${input.dueRetests.slice(0, 2).join(" and ")} and haven't yet seen them do it alone. After answering what they said, offer one short retest of it — as an offer, never a demand.` : "")
    + solutionBlock(input.solution)
    + solutionMatchLine(message, input.solution)
    + (misgraded ? `\n\nCHECKED BY CODE — THEY WERE RIGHT: ${misgraded} Say so plainly (the exercise's key was wrong, not them) and move on.` : "")
    + ownArithmeticLine(message)
    + stepVerdictLine(input.stepVerdict)
    + (focusText ? `\n\nTHE PROBLEM RIGHT NOW (stay on it; the session memory and earlier problems are about OTHER work — never mix them in, and use only the objects, quantities and numbers this problem and the student gave): ${focusText.slice(0, 400)}` : "")
    + (usedExercises.length ? `\n\n${exercisesBlock(usedExercises)}` : "")
    + (() => { const v = varietyLine(recentQuestionKinds(history)); return v ? `\n\n${v}` : ""; })()
    + factsBlock({ policy, verdict: input.stepVerdict, solvedInChat: solvedNow[0]?.question, wrongInChat: wrongNow, wants, teaching: input.teaching, affect, adapt: [...sessionGuide({ message, history, log: input.teaching?.log, correctNow: verdict === "correct", openWork: problems.some((p) => !p.solved) || board.some((b) => b.kind === "gap" && b.status !== "correct"), hasObjectives: objectives.length > 0, different: wants.different, finalReached: solvedNow.length > 0 || reachedSolutionSteps(message, input.solution).includes(0) || (problems.length > 0 && problems.every((p) => p.solved)), level: [context.profile?.yearLevel, context.profile?.track === "ib" ? "IB" : context.profile?.track === "ap" ? "AP" : context.profile?.track === "bac" ? "bac" : "", ...(context.profile?.courses || []).slice(0, 4)].filter(Boolean).join(", ") }), ...adaptationLines(input.teaching?.log, { wrong: verdict === "incorrect", stuck: STUCK.test(message) })] })
    + (input.spoken && spokenRepair ? voiceInputBlock(message, input.spoken.alternatives, spokenRepair) : "")
    + `\n\nReply in ${fr ? "French" : "English"} unless the student is writing in another language. Return ONLY the JSON object.`;

  const messages: any[] = [
    { role: "system", content: system },
    ...history.slice(-MAX_HISTORY).filter((h) => h.text?.trim()).map((h) => ({ role: h.role, content: h.text.slice(0, 4000) })),
    { role: "user", content: message },
  ];

  const said = [...history.filter((h) => h.role === "user").map((h) => h.text), message, input.solution?.statement || "", ...(spokenRepair ? [spokenRepair.interpreted, ...(input.spoken?.alternatives || [])] : []), ...problems.map((p) => p.question || ""), ...board.filter((b) => b.kind === "given" || b.owner === "student").map((b) => b.text)];
  const vctx: VerifyContext = { message, history, board, problems, solution: input.solution, policy, wants: { why: wants.why, write: wants.write, restart: wants.restart, exercise: wants.exercise, draw: wants.draw, problemOnBoard: wants.problemOnBoard, different: wants.different }, said, discussion, usedExercises, verdict };

  // ── One structured call (+ one retry if it isn't JSON at all) ──
  let turn: TurnOutput | null = null, raw = "";
  try {
    ({ turn, raw } = await callTurn(messages, result.tokens));
    if (!turn) ({ turn, raw } = await callTurn([...messages, { role: "assistant", content: raw.slice(0, 2000) }, { role: "user", content: "(That wasn't the JSON object. Send the same turn again as ONLY the JSON object described above.)" }], result.tokens));
  } catch (e: any) {
    console.error(`[tutor] model request failed: ${e?.message || e}`);
    result.error = true;
    return result;
  }
  // Both tries were prose or cut-off JSON: the model's own words still beat an error message.
  if (!turn) turn = normalizeTurn(salvageTurn(raw, { prose: true }));
  if (!turn) { console.error("[tutor] no usable JSON turn"); result.error = true; return result; }

  // ── Verify, repair once, then fix in code what's left ──
  let issues: Issue[] = verifyTurn(turn, vctx);
  let repaired = false;
  const firstIssues = issues.map((i) => i.code);
  if (issues.length) {
    try {
      const fixed = await callTurn([...messages, { role: "assistant", content: raw.slice(0, 6000) }, { role: "user", content: `(Before the student sees it, fix this turn:\n- ${issues.map((i) => i.fix).join("\n- ")}\nSend the corrected turn as ONLY the JSON object. Don't mention this note.)` }], result.tokens);
      if (fixed.turn) { const again = verifyTurn(fixed.turn, vctx); if (again.length < issues.length || !again.some((i) => i.hard)) { turn = fixed.turn; issues = again; repaired = true; } }
    } catch (e: any) { console.warn(`[tutor] repair call failed: ${e?.message || e}`); }
  }
  if (issues.length) turn = degradeTurn(turn, vctx);
  if (issues.some((i) => i.code === "leak")) { result.guardrailTripped = true; result.leakedValue = "an answer key"; }
  // Every sentence gave something away: one rewrite in the model's own words, never a stock line.
  if (!turn.speech.length) {
    const draft = raw.slice(0, 2000);
    const text = await rewriteReply(draft, issues.map((i) => i.fix).join("; "), message, result.tokens);
    if (!text) { result.error = true; return result; }
    turn = { ...turn, speech: [text] };
  }

  // ── Exercises always come through the answer widget, generated at their level ──
  let problemsForApply = problems;
  {
    const speechAll = turn.speech.join(" ");
    const newExercise = !wants.problemOnBoard && (wants.exercise || wants.different || turn.move === "practice");
    const levelText = [context.profile?.yearLevel, context.profile?.track === "ib" ? "IB Diploma" : context.profile?.track === "ap" ? "AP" : context.profile?.track === "bac" ? "baccalauréat" : "", ...(context.profile?.courses || []).slice(0, 4)].filter(Boolean).join(", ");
    if (newExercise) {
      const topic = objectives.find((o) => !o.done)?.label || [...board].reverse().find((b) => b.kind === "focus" && b.text)?.text || context.subject || "";
      const used = exercisesSoFar({ history, problems, memory: context.memory, board });
      const kinds = recentQuestionKinds(history);
      const nextKind = (["compute", "explain_why", "spot_error", "predict", "compare"] as const).find((k) => !kinds.includes(k)) ?? "any";
      const gen = await generateProblem({
        subject: context.subject, topic: wants.different ? "" : topic, level: levelText, difficulty: difficultyAsked(message) ?? difficultyFrom(input.teaching?.log),
        kind: isDiscussionSubject(context.subject, speechAll) && nextKind === "compute" ? "explain_why" : nextKind,
        used, lang: fr ? "fr" : "en", ask: wants.exercise || wants.different ? message.slice(0, 200) : undefined,
      }, result.tokens);
      if (gen) {
        // The widget carries the problem text; the speech keeps only the lead-in (the sentences before the problem is stated).
        // The problem starts at the first sentence with a number from which the rest of the reply poses a problem.
        const at = turn.speech.findIndex((sn, i) => /\d/.test(sn) && (statesAProblem(turn!.speech.slice(i).join(" ")) || (/\?\s*$/.test(sn) && countWordsLite(sn) >= 8)));
        let speech = at >= 0 ? turn.speech.slice(0, at) : turn.speech.filter((sn) => !/\?\s*$/.test(sn));
        if (!speech.length || !/[.!?]\s*$/.test(speech[speech.length - 1])) speech = [...speech, gen.intro];
        else if (!speech.some((sn) => sn === gen.intro) && !/\b(?:try|work out|find|what|which|how)\b/i.test(speech[speech.length - 1])) speech = [...speech, gen.intro];
        const ops = turn.board.filter((o) => o.op !== "problem" && !(wants.different && o.op === "topic"));
        if (wants.different && gen.topic) ops.unshift({ op: "topic", cue: 0, text: gen.topic });
        ops.push({ op: "problem", cue: Math.max(0, speech.length - 1), ...(gen.input as any) });
        turn = { ...turn, speech, board: ops.map((o) => ({ ...o, cue: Math.min(o.cue, Math.max(0, speech.length - 1)) })), expects: "value" };
        if (wants.different) problemsForApply = problems.map((p) => ({ ...p, solved: true }));
      } else console.warn("[tutor] problem generator returned nothing — keeping the tutor's own exercise, if any");
    } else if (wants.problemOnBoard) {
      // A problem that already exists (Otto stated it, or they pasted it): the widget gets it with a code-verified key from the solver.
      const text = problemStatement({ opQuestion: turn.board.find((o) => o.op === "problem")?.question, history: [...history, { role: "assistant", text: speechAll }], openProblem: [...problems].reverse().find((p) => !p.solved)?.question, studentStated: studentProblemStatement(message) });
      if (text && !problems.some((p) => !p.solved && sameExercise(p.question, text, 0.7))) {
        let sol = input.solution && sameExercise(input.solution.statement, text, 0.6) ? input.solution : null;
        if (!sol) { const solved = await solveProblem(text, context.subject); result.tokens.in += solved.tokens.in; result.tokens.out += solved.tokens.out; sol = solved.solution; }
        if (sol?.verified && Number.isFinite(sol.value)) {
          const ops = turn.board.filter((o) => o.op !== "problem");
          ops.push({ op: "problem", cue: Math.max(0, turn.speech.length - 1), question: text, answer: sol.finalAnswer, check: String(sol.value), format: "a number (units as in the problem)" } as any);
          turn = { ...turn, board: ops };
          problemsForApply = problems.map((p) => ({ ...p, solved: true }));
        }
      }
    }
  }

  // ── Board ──
  const theirWords = [message, ...(spokenRepair ? [spokenRepair.interpreted] : [])];
  const applied = applyOps(turn.board, { message, theirWords, board, problems: problemsForApply, fr, solution: input.solution });
  // "Write what I wrote" always ends with their line on the board, even if the model's step was refused.
  if (wants.write && !applied.board.some((e) => e.owner === "student")) {
    const line = studentBoardLine([spokenRepair?.interpreted || "", message, ...history.filter((h) => h.role === "user").slice(-2).reverse().map((h) => h.text)]);
    if (line) applied.board.push(...applyOps([{ op: "step", cue: 0, text: line, kind: "result", owner: "student" }], { message, theirWords: [...theirWords, line], board: [...board, ...applied.board], problems, fr }).board);
  }
  // THE PROBLEM IS ON THE BOARD whatever the model did: asked for it, or Otto just stated a new one in words only.
  {
    const placed = applied.board.some((e) => e.kind === "given") || applied.problems.length > 0;
    const speechAll = turn.speech.join(" ");
    const statesNew = posesProblemInProse(speechAll) && (wants.exercise || wants.different) && !problems.some((p) => !p.solved);
    if (!placed && (wants.problemOnBoard || statesNew)) {
      const opQ = turn.board.find((o) => o.op === "problem")?.question;
      const text = problemStatement({ opQuestion: opQ, history: [...history, { role: "assistant", text: speechAll }], openProblem: [...problems].reverse().find((p) => !p.solved)?.question, studentStated: studentProblemStatement(message) });
      const onBoardAlready = !!text && [...board, ...applied.board].some((e) => (e.kind === "given" || e.kind === "focus") && e.text && sameExercise(e.text, text, 0.7));
      if (text && !onBoardAlready) {
        const r = applyOps([{ op: "step", cue: 0, text, kind: "given", why: fr ? "L'énoncé" : "The problem" }], { message, theirWords, board: [...board, ...applied.board], problems, fr });
        applied.board.push(...r.board);
        if (r.dropped.length) applied.dropped.push(...r.dropped);
      }
    }
  }
  result.board = applied.board;
  result.problems = applied.problems;
  if (applied.objectives) result.objectives = applied.objectives;
  if (applied.dropped.length) console.log(`[tutor] dropped ops: ${applied.dropped.join(" | ")}`);

  // The board ops can still fail to build (a bad figure spec, a duplicate): then the speech must not claim them.
  if (turn.speech.some(claimsBoard) && !applied.board.some((e) => e.kind !== "annotation" && e.kind !== "focus") && !applied.problems.length) {
    const kept = turn.speech.filter((s) => !claimsBoard(s));
    if (kept.length) turn = { ...turn, speech: kept };
    else {
      const text = await rewriteReply(turn.speech.join(" "), "it says something is on the board but nothing could be put there — say the idea in words only, no mention of the board", message, result.tokens);
      if (text) turn = { ...turn, speech: [text] };
    }
  }

  // ── Reply ──
  let reply = turn.speech.join(" ");
  if (mentionsMechanics(reply)) reply = stripMechanics(reply) || reply;
  reply = dropRepeatedName(stripPraiseOpener(reply), history);
  result.reply = reply;
  result.plan = planOf(turn);
  const progressed = verdict === "correct" || reachedSolutionSteps(message, input.solution).length > 0;
  const struggled = verdict === "incorrect" || STUCK.test(message) || ["misconception", "slip", "no_attempt"].includes(turn.diagnosis.status);
  result.turn = {
    speech: turn.speech, ...(turn.angle ? { angle: turn.angle } : {}), ...(turn.diagnosis.misconception ? { misconception: turn.diagnosis.misconception } : {}), move: turn.move, support: MOVE_SUPPORT[turn.move], intent: turn.intent, diagnosis: turn.diagnosis.status,
    repaired, issues: firstIssues, dropped: applied.dropped, ms: Date.now() - t0, struggled: struggled && !progressed,
  };
  return result;
}

export type { TurnOutput };
export type { BoardEntry, TaskObjective, TaskProblem, TutorSolution };
