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
import { MOVE_SUPPORT, normalizeTurn, extractJsonObject, type TurnOutput } from "../../shared/tutorTurn.ts";
import { repairSpokenMath, spokenContextFrom, type SpokenRepair } from "../../shared/spokenMath.ts";
import { boardSurfaceBlock } from "../boardEvents.ts";
import { solutionBlock } from "../solver.ts";
import { createTutorChat, retryRequest, usageOf, OUT, nowBlock, rewriteReply, stepVerdictLine } from "../claude.ts";
import { asksWhy, asksToWrite, voiceInputBlock } from "../tutorAdapt.ts";
import {
  backgroundBlock, objectivesBlock, solutionMatchLine, misgradedExercise, ownArithmeticLine, answeredInChat, wrongInChat,
  isDiscussionSubject, DISCUSSION_BLOCK, needsExplanation, asksToRestart, wantsExercise, reachedSolutionSteps,
  studentBoardLine, stripPraiseOpener, dropRepeatedName, stripMechanics, mentionsMechanics, affectOf,
  type TutorTurnInput, type TutorTurnResult, type TutorPlanLite,
} from "../tutor.ts";
import { TURN_PROMPT, VOICE_NOTE } from "./prompt.ts";
import { supportPolicy, asksForWorkedExample, adaptationLines, type Policy } from "./policy.ts";
import { verifyTurn, degradeTurn, type Issue, type VerifyContext } from "./verify.ts";
import { applyOps } from "./apply.ts";
import { sessionGuide } from "./guide.ts";

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
    f.wants.write ? "THEY ASKED YOU TO WRITE THEIR WORKING: put their last step on the board as their own line (owner student)." : "",
    f.wants.restart ? "THEY ASKED TO START OVER: open a fresh worksheet (topic op), restate the givens, explain the first idea slowly." : "",
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
  return { turn: normalizeTurn(extractJsonObject(raw)), raw };
}

export interface TurnExtras {
  /** The reply as sentences, in order — the board ops' cues index into this. */
  speech: string[];
  angle?: string;
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

export async function runTutorTurn(input: TutorTurnInput): Promise<TutorTurnResult & { turn?: TurnExtras }> {
  const t0 = Date.now();
  const { message, history, board, problems, objectives, context, lang } = input;
  const fr = lang === "fr";
  const result: TutorTurnResult & { turn?: TurnExtras } = { reply: "", board: [], problems: [], tokens: { in: 0, out: 0, cachedIn: 0 }, guardrailTripped: false };

  // ── Facts, by code ──
  const solvedNow = problems.filter((p) => answeredInChat(message, p));
  if (solvedNow.length) { for (const p of solvedNow) p.solved = true; result.solvedInChat = solvedNow.map((p) => p.id); }
  const wrongNow = !solvedNow.length && problems.some((p) => wrongInChat(message, p));
  const spokenRepair: SpokenRepair | null = input.spoken ? repairSpokenMath(message, spokenContextFrom([context.subject || "", ...board.map((b) => b.text || ""), ...problems.map((p) => p.question || "")])) : null;
  const wants = { why: asksWhy(message), write: asksToWrite(message), restart: asksToRestart(message), exercise: wantsExercise(message), explain: needsExplanation(message, input.teaching) };
  const verdict = input.stepVerdict?.verdict ?? (solvedNow.length ? "correct" : wrongNow ? "incorrect" : undefined);
  const policy = supportPolicy({ teaching: input.teaching, needsExplanation: wants.explain, asksWhy: wants.why, asksForWorkedExample: asksForWorkedExample(message), verdict });
  const discussion = isDiscussionSubject(context.subject, [message, ...history.slice(-4).map((h) => h.text)].join(" "));
  const affect = affectOf(message);
  const misgraded = misgradedExercise(message, input.solution);

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
    + factsBlock({ policy, verdict: input.stepVerdict, solvedInChat: solvedNow[0]?.question, wrongInChat: wrongNow, wants, teaching: input.teaching, affect, adapt: [...sessionGuide({ message, history, log: input.teaching?.log, correctNow: verdict === "correct", openWork: problems.some((p) => !p.solved) || board.some((b) => b.kind === "gap" && b.status !== "correct"), hasObjectives: objectives.length > 0 }), ...adaptationLines(input.teaching?.log, { wrong: verdict === "incorrect", stuck: STUCK.test(message) })] })
    + (input.spoken && spokenRepair ? voiceInputBlock(message, input.spoken.alternatives, spokenRepair) : "")
    + `\n\nReply in ${fr ? "French" : "English"} unless the student is writing in another language. Return ONLY the JSON object.`;

  const messages: any[] = [
    { role: "system", content: system },
    ...history.slice(-MAX_HISTORY).filter((h) => h.text?.trim()).map((h) => ({ role: h.role, content: h.text.slice(0, 4000) })),
    { role: "user", content: message },
  ];

  const said = [...history.filter((h) => h.role === "user").map((h) => h.text), message, input.solution?.statement || "", ...(spokenRepair ? [spokenRepair.interpreted, ...(input.spoken?.alternatives || [])] : []), ...problems.map((p) => p.question || ""), ...board.filter((b) => b.kind === "given" || b.owner === "student").map((b) => b.text)];
  const vctx: VerifyContext = { message, history, board, problems, solution: input.solution, policy, wants: { why: wants.why, write: wants.write, restart: wants.restart, exercise: wants.exercise }, said, discussion };

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

  // ── Board ──
  const theirWords = [message, ...(spokenRepair ? [spokenRepair.interpreted] : [])];
  const applied = applyOps(turn.board, { message, theirWords, board, problems, fr, solution: input.solution });
  // "Write what I wrote" always ends with their line on the board, even if the model's step was refused.
  if (wants.write && !applied.board.some((e) => e.owner === "student")) {
    const line = studentBoardLine([spokenRepair?.interpreted || "", message, ...history.filter((h) => h.role === "user").slice(-2).reverse().map((h) => h.text)]);
    if (line) applied.board.push(...applyOps([{ op: "step", cue: 0, text: line, kind: "result", owner: "student" }], { message, theirWords: [...theirWords, line], board: [...board, ...applied.board], problems, fr }).board);
  }
  result.board = applied.board;
  result.problems = applied.problems;
  if (applied.objectives) result.objectives = applied.objectives;
  if (applied.dropped.length) console.log(`[tutor] dropped ops: ${applied.dropped.join(" | ")}`);

  // ── Reply ──
  let reply = turn.speech.join(" ");
  if (mentionsMechanics(reply)) reply = stripMechanics(reply) || reply;
  reply = dropRepeatedName(stripPraiseOpener(reply), history);
  result.reply = reply;
  result.plan = planOf(turn);
  const progressed = verdict === "correct" || reachedSolutionSteps(message, input.solution).length > 0;
  const struggled = verdict === "incorrect" || STUCK.test(message) || ["misconception", "slip", "no_attempt"].includes(turn.diagnosis.status);
  result.turn = {
    speech: turn.speech, ...(turn.angle ? { angle: turn.angle } : {}), move: turn.move, support: MOVE_SUPPORT[turn.move], intent: turn.intent, diagnosis: turn.diagnosis.status,
    repaired, issues: firstIssues, dropped: applied.dropped, ms: Date.now() - t0, struggled: struggled && !progressed,
  };
  return result;
}

export type { TurnOutput };
export type { BoardEntry, TaskObjective, TaskProblem, TutorSolution };
