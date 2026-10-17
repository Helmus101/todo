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
import { normalizeStudentModel, findConcept, independentSuccess, liveMisconceptions } from "../studentModel.ts";
import { falseClaim, worthFactChecking } from "./factcheck.ts";
import { createTutorChat, retryRequest, usageOf, OUT, rewriteReply, stepVerdictLine } from "../claude.ts";
import { asksWhy, asksToWrite, asksToDraw, voiceInputBlock, similarity, posesProblemInProse, studentProblemStatement } from "../tutorAdapt.ts";
import {
  backgroundBlock, objectivesBlock, solutionMatchLine, misgradedExercise, ownArithmeticLine, answeredInChat, wrongInChat,
  isDiscussionSubject, DISCUSSION_BLOCK, needsExplanation, asksToRestart, wantsExercise, reachedSolutionSteps,
  studentBoardLine, stripPraiseOpener, dropRepeatedName, stripMechanics, mentionsMechanics, affectOf,
  type TutorTurnInput, type TutorTurnResult, type TutorPlanLite,
} from "../tutor.ts";
import { TURN_PROMPT, VOICE_NOTE } from "./prompt.ts";
import { supportPolicy, asksForWorkedExample, adaptationLines, questionRun, type Policy } from "./policy.ts";
import { verifyTurn, degradeTurn, revealsKey, acceptsBoardOffer, claimsBoard, hasVisual, sceneNounsIn, type Issue, type VerifyContext } from "./verify.ts";
import { applyOps } from "./apply.ts";
import { sessionGuide } from "./guide.ts";
import { studentComplaint, type Complaint, wantsTopicSwitch, asksToWriteProblem, wantsDifferent, problemStatement, wantsMoreExercises, difficultyAsked, cantSeeProblem } from "./intents.ts";
import { generateProblem, difficultyFrom } from "./problemGen.ts";
import { goalsKnown, mergeGoals } from "./goals.ts";
import type { SessionGoals } from "../../shared/types.ts";
import { sessionScope, inScope, contentWords, sameSubjectMemory, cleanObjectives } from "./scope.ts";
import { exercisesSoFar, exercisesBlock, recentQuestionKinds, varietyLine, sameExercise, questionKind } from "./exercises.ts";
import { parseExerciseResults, verdictFromResults } from "./results.ts";

const MAX_HISTORY = 14;
/** A turn is a few hundred tokens of JSON; this only bounds a runaway reply (and its wait), it doesn't shape normal ones. */
const TURN_MAX_TOKENS = 6000;
/** Two sentences share a run of `n` consecutive words (ignoring case and punctuation). */
export function sharesWordRun(a: string, b: string, n: number): boolean {
  const w = (t: string) => t.toLowerCase().replace(/[^a-zà-ÿ0-9' ]/g, " ").split(/\s+/).filter(Boolean);
  const wa = w(a), wb = w(b).join(" ");
  for (let i = 0; i + n <= wa.length; i++) if (wb.includes(wa.slice(i, i + n).join(" "))) return true;
  return false;
}

/** A lead-in that describes the exercise ahead ("here's one where brackets and a fraction show up"): only the generator knows what it built, so such sentences are dropped and its own intro is used. */
/** What to do when the student points out a fault in the session itself: say it plainly, fix it THIS turn, don't defend or grovel. */
const COMPLAINT_FIX: Record<Complaint, string> = {
  board: "THEY SAY SOMETHING IS MISSING FROM THE BOARD. Check the board listing: if what you talked about isn't there, say so in one short plain sentence (no grovelling) and WRITE it now — the equation or the problem with its numbers — then continue from it.",
  setup: "THEY DON'T KNOW WHAT YOU ARE REFERRING TO: you skipped the set-up. In one short sentence own it, then state the situation in full (what the objects are, the numbers) and put it on the board as a given line before asking anything.",
  repeat: "THEY SAY YOU ALREADY SAID / ASKED THIS. Don't repeat it: say what the answer to it was (from the conversation), and move on with something NEW — the next step, or a different angle if they were stuck.",
  ignored: "THEY SAY YOU DIDN'T ANSWER WHAT THEY ASKED. Re-read their previous message, answer THAT directly first (briefly, plainly), and only then steer back.",
  wrong: "THEY SAY YOU ARE WRONG. Re-derive your last claim from the givens step by step before you reply. If you were wrong, say so plainly, give the correct version and correct the board; if you were right, explain the one step that shows it — kindly, with the numbers, without giving way just to please.",
  unclear: "THEY SAY YOUR EXPLANATION DIDN'T LAND. Do not repeat it: choose a different angle (a concrete number case, a picture on the board, an analogy, or one smaller step), keep it short, and ask one small check question.",
};

export const DESCRIBES_EXERCISE = /^\s*(?:work out|calculate|find|determine|solve|compute|tell me (?:what|which|how)|show that|write down|predict)\b|\b(?:here'?s|here is|this one|this next one|the next one|in this one|you(?:'ll| will)? (?:have to|need to|must|get to)|show(?:s)? up|where you|exam-style|full (?:exam|worksheet)|set it up with|let'?s (?:try|do|look at|go through|work through|see) (?:a|an|one|this|another))\b/i;
const STILL_LOST = /\b(?:(?:i )?still (?:don'?t|do not|can'?t) (?:get|understand|see|follow)|(?:explain|say|show) (?:it |that )?again|i'?m (?:still )?(?:lost|confused)|je (?:ne )?comprends (?:toujours )?pas|toujours pas compris|explique (?:encore|à nouveau|autrement))\b/i;
const STUCK = /\b(?:i (?:don'?t|do not) (?:know|get it|understand)|still (?:don'?t|do not) (?:get|understand)|(?:explain|say) (?:it )?again|idk|no idea|i'?m (?:stuck|lost|confused)|not sure|je (?:ne )?sais pas|j'?sais pas|aucune idée|je suis (?:perdu|bloqué)e?|je comprends pas|help me|aide[- ]moi)\b/i;

/** The turn the app has already worked out, as a prompt block the model must respect. Exported for tests. */
export function factsBlock(f: { policy: Policy; verdict?: { gap: string; given: string; verdict: "correct" | "incorrect" }; solvedInChat?: string; wrongInChat?: boolean; wrongPick?: string; keyDoubt?: boolean; complaint?: Complaint | null; wants: VerifyContext["wants"] & { explain: boolean }; teaching?: TutorTeachingState; affect: string; adapt?: string[] }): string {
  const lines = [
    `SUPPORT ALLOWED THIS TURN: up to level ${f.policy.maxSupport} (${f.policy.reason}). Allowed moves: ${f.policy.allowed.join(", ")}.`,
    f.verdict ? `THEIR STEP, CHECKED BY CODE: "${f.verdict.given}" for the open line "${f.verdict.gap}" is ${f.verdict.verdict === "correct" ? "RIGHT — credit exactly what was right" : "WRONG — find the first thing that's off; don't give the value"}.` : "",
    f.solvedInChat ? `THEY JUST ANSWERED THE OPEN EXERCISE IN CHAT AND IT IS RIGHT (code-checked): "${f.solvedInChat.slice(0, 160)}". Confirm it — never ask them to type it into the box — then deepen it (ask why it works or give a variation) before moving on.` : "",
    f.keyDoubt ? "THE ANSWER BOX MARKED THEIR NUMBER WRONG, BUT AN INDEPENDENT SOLUTION AGREES WITH THEM — the exercise's stored answer is probably the mistaken one. Tell them plainly that their answer is right and the check was off (that's on the app, not them), credit their method, then move on or deepen it. Never hint that they made an error." : "",
    f.wrongPick ? `THEIR ANSWER-BOX CHOICE WAS WRONG ("${f.wrongPick.slice(0, 160)}"). A wrong choice shows what they believe: say in plain words what idea makes that choice attractive (name the belief gently, set diagnosis.misconception), then test it with a fresh case or a counter-example instead of just saying it's wrong. Don't say which option is right.` : "",
    f.wrongInChat ? "Their number for the open exercise is WRONG (code-checked): look for the first slip, no new exercise." : "",
    f.wants.why ? "THEY ASKED WHY: give the real reason first, in plain words." : "",
    f.wants.explain && !f.wants.why ? "THEY NEED IT EXPLAINED (lost, asked to be shown, or stuck): teach the missing idea plainly and write it on the board as you say it, then hand back one small step." : "",
    f.wants.problemOnBoard ? "THEY ASKED YOU TO PUT THE PROBLEM ON THE BOARD (or can't see it / don't know what is asked): in THIS turn say in one plain sentence what is given and what is asked, put the FULL problem on the board (the app shows it in the answer widget), then ask the first step. Don't ask a different question instead." : "",
    f.complaint ? COMPLAINT_FIX[f.complaint] : "",
    f.wants.topicSwitch ? "THEY SWITCHED TOPIC. This turn: open a fresh worksheet with a topic op, make a plan op for the NEW topic (2–3 objectives), and put the first problem on the board as a given line WITH its numbers (state what the objects are) before you ask about it. Say in a few words that the old topic is parked. From now on stay on the new topic: do not drift back to the old plan or to old exercises unless they ask." : "",
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
  const ask = async (json: boolean) => retryRequest(() => createTutorChat({ max_tokens: TURN_MAX_TOKENS, temperature: 0.5, messages, ...(json ? { response_format: { type: "json_object" } } : {}) }, true), 2, 400);
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
  /** What they've told us they want from the sitting, merged with what was known (saved on the teaching state). */
  goals?: SessionGoals;
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
  /** The verified outcome of the student's step or exercise this turn (board gap, answer in chat, or widget result). */
  verdict?: "correct" | "incorrect";
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
  // Other subjects' memory never reaches this session (a labour-market plan in a physics session).
  input = { ...input, context: { ...input.context, memory: sameSubjectMemory(input.context.memory, input.context.subject) } };
  // Objectives a past (bad) turn saved that the session never supports — an economics goal in a physics session — are purged
  // here, before anything uses them (the plan block, the generator's topic, the pinned goal on the board).
  const baseScope = sessionScope({ subject: input.context.subject, objectives: [], board: input.board, problems: input.problems, history: input.history, message: input.message, memory: input.context.memory });
  const cleanObjs = cleanObjectives(input.objectives, baseScope);
  const purgedObjectives = cleanObjs.length < input.objectives.length;
  input = { ...input, objectives: cleanObjs };
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
  // "write on board" with nothing of theirs to write, while a problem is in play, means THE PROBLEM.
  const nothingOfTheirs = !studentBoardLine([message]);
  const problemInPlay = problems.some((p) => !p.solved) || history.slice(-4).some((h) => h.role === "assistant" && statesAProblem(h.text));
  const problemOnBoard = asksToWriteProblem(message) || cantSeeProblem(message) || (asksToWrite(message) && nothingOfTheirs && problemInPlay && message.length < 60);
  const wants = { why: asksWhy(message), write: asksToWrite(message) && !problemOnBoard, problemOnBoard, different: wantsDifferent(message), topicSwitch: wantsTopicSwitch(message), restart: asksToRestart(message), exercise: wantsExercise(message) || wantsMoreExercises(message), explain: needsExplanation(message, input.teaching) && (history.length > 0 || /\b(?:explain|understand|lost|confus|no idea|idk|dunno|don'?t get|expliqu|compren|perdu)/i.test(message)), draw: asksToDraw(message) || acceptsBoardOffer(message, history) };
  // An answer-widget or answer-box result ("[Exercise] … marked right/wrong") is a verified outcome like any other step check.
  const reported = parseExerciseResults(message);
  let verdict = input.stepVerdict?.verdict ?? (solvedNow.length ? "correct" : wrongNow ? "incorrect" : undefined) ?? verdictFromResults(reported);
  // A numeric exercise marked wrong twice: if an independent solve lands on THEIR number and not the key, the key is the suspect.
  let keyDoubt = false;
  const lastWidget = [...reported].reverse().find((r) => r.source === "widget");
  // …or they push back in chat on a number the box marked wrong ("but isn't it 2.04?").
  const numIn = (t: string) => (String(t).replace(",", ".").match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  let disputed: string | undefined;
  if (!reported.length && /\b(?:isn'?t it|shouldn'?t it|i thought|are you sure|that'?s what i|i got|c'est pas|non mais|pas plut[ôo]t|je trouve)\b/i.test(message)) {
    const prior = history.filter((h) => h.role === "user").slice(-4).flatMap((h) => parseExerciseResults(h.text)).filter((r) => r.source === "widget" && r.verdict === "incorrect" && r.given);
    const hit = [...prior].reverse().find((r) => numIn(message).some((n) => numIn(r.given!).some((g) => Math.abs(g - n) <= Math.max(Math.abs(n) * 0.005, 1e-6))));
    if (hit) disputed = hit.given;
  }
  if ((verdict === "incorrect" || disputed) && (disputed || (lastWidget && (lastWidget.attempt || 0) >= 2)) && process.env.TUTOR_KEYCHECK !== "off") {
    const open = [...problems].reverse().find((p) => !p.solved && !(p.options && p.options.length));
    const theirs = numIn(disputed || lastWidget?.given || "").pop() ?? NaN;
    const key = Number(String(open?.answer ?? "").replace(",", ".").match(/-?\d+(?:\.\d+)?/)?.[0]);
    if (open && Number.isFinite(theirs) && Number.isFinite(key)) {
      try {
        const r = await solveProblem(String(open.question), context.subject);
        result.tokens.in += r.tokens.in; result.tokens.out += r.tokens.out;
        const v = r.solution?.verified ? Number(r.solution.value) : NaN;
        const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(b) * 0.015, 0.0006);
        if (Number.isFinite(v) && close(theirs, v) && !close(key, v)) { keyDoubt = true; verdict = "correct"; }
      } catch { /* keep the app's mark */ }
    }
  }
  const policy = supportPolicy({ teaching: input.teaching, needsExplanation: wants.explain, asksWhy: wants.why, asksForWorkedExample: asksForWorkedExample(message), verdict, questionRun: questionRun(input.teaching?.log) });
  const discussion = isDiscussionSubject(context.subject, [message, ...history.slice(-4).map((h) => h.text)].join(" "));
  const goalsAreKnown = goalsKnown(input.teaching?.goals, message, objectives.length > 0);
  const scope = sessionScope({ subject: context.subject, objectives, board, problems, history, message, memory: context.memory });
  void baseScope;
  const affect = affectOf(message);
  const misgraded = misgradedExercise(message, input.solution);
  const usedExercises = exercisesSoFar({ history, problems, memory: context.memory, board });

  const system = TURN_PROMPT
    + (input.voiceMode ? VOICE_NOTE : "")
    + backgroundBlock(context)
    + (discussion ? DISCUSSION_BLOCK : "")
    + objectivesBlock(wants.topicSwitch ? [] : objectives).replace(/SET_OBJECTIVES/g, "a plan op")
    + `\n\nToday is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} (for deadlines only).`
    + `\n\nTHE BOARD (margin numbers #n are what you point at)${boardSurfaceBlock(board, problems) || ": empty — open it with a topic op and the starting point."}`
    + (input.dueRetests?.length && history.length <= 1 ? `\n\nOPENING THE SITTING: last time you helped them with ${input.dueRetests.slice(0, 2).join(" and ")} and haven't yet seen them do it alone. After answering what they said, offer one short retest of it — as an offer, never a demand.` : "")
    + solutionBlock(input.solution)
    + solutionMatchLine(message, input.solution)
    + (misgraded ? `\n\nCHECKED BY CODE — THEY WERE RIGHT: ${misgraded} Say so plainly (the exercise's key was wrong, not them) and move on.` : "")
    + ownArithmeticLine(message)
    + stepVerdictLine(input.stepVerdict)
    + (focusText ? `\n\nTHE PROBLEM RIGHT NOW (stay on it; the session memory and earlier problems are about OTHER work — never mix them in, and use only the objects, quantities and numbers this problem and the student gave): ${focusText.slice(0, 400)}` : "")
    + (context.subject ? `\n\nSESSION TOPIC: ${context.subject}${objectives.length ? ` — plan: ${objectives.map((o) => o.label).join("; ")}` : ""}. Every plan, worksheet, question and exercise stays on this subject and plan; never bring in another subject or an unrelated topic unless the student asks for it.` : "")
    + (usedExercises.length ? `\n\n${exercisesBlock(usedExercises)}` : "")
    + (() => { const v = varietyLine(recentQuestionKinds(history)); return v ? `\n\n${v}` : ""; })()
    + factsBlock({ policy, verdict: input.stepVerdict, solvedInChat: solvedNow[0]?.question, wrongInChat: wrongNow, keyDoubt, complaint: studentComplaint(message), wrongPick: keyDoubt ? undefined : reported.find((r) => r.verdict === "incorrect" || r.verdict === "partial")?.given, wants, teaching: input.teaching, affect, adapt: [...sessionGuide({ message, history, log: input.teaching?.log, correctNow: verdict === "correct", openWork: problems.some((p) => !p.solved) || board.some((b) => b.kind === "gap" && b.status !== "correct"), hasObjectives: objectives.length > 0, goals: input.teaching?.goals, goalsKnown: goalsAreKnown, different: wants.different, finalValue: input.solution?.finalAnswer, finalReached: solvedNow.length > 0 || reachedSolutionSteps(message, input.solution).includes(0) || (problems.length > 0 && problems.every((p) => p.solved)), level: [context.profile?.yearLevel, context.profile?.track === "ib" ? "IB" : context.profile?.track === "ap" ? "AP" : context.profile?.track === "bac" ? "bac" : "", ...(context.profile?.courses || []).slice(0, 4)].filter(Boolean).join(", ") }), ...adaptationLines(input.teaching?.log, { wrong: verdict === "incorrect", stuck: STUCK.test(message) || STILL_LOST.test(message), stillLost: STILL_LOST.test(message) }, history.filter((h) => h.role === "assistant").slice(-4).map((h) => h.text.toLowerCase().replace(/[^a-zà-ÿ' ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).join(" ")).filter(Boolean))] })
    + (input.spoken && spokenRepair ? voiceInputBlock(message, input.spoken.alternatives, spokenRepair) : "")
    + `\n\nReply in ${fr ? "French" : "English"} unless the student is writing in another language. Return ONLY the JSON object.`;

  const messages: any[] = [
    { role: "system", content: system },
    ...history.slice(-MAX_HISTORY).filter((h) => h.text?.trim()).map((h) => ({ role: h.role, content: h.text.slice(0, 4000) })),
    { role: "user", content: message },
  ];

  const said = [...history.filter((h) => h.role === "user").map((h) => h.text), message, input.solution?.statement || "", ...(spokenRepair ? [spokenRepair.interpreted, ...(input.spoken?.alternatives || [])] : []), ...problems.map((p) => p.question || ""), ...board.filter((b) => b.kind === "given" || b.owner === "student").map((b) => b.text)];
  const vctx: VerifyContext = { message, history, board, problems, solution: input.solution, policy, wants: { why: wants.why, write: wants.write, restart: wants.restart, exercise: wants.exercise, draw: wants.draw, problemOnBoard: wants.problemOnBoard, different: wants.different, topicSwitch: wants.topicSwitch }, said, discussion, usedExercises, verdict, keyDoubt, scope, goalsKnown: goalsAreKnown };

  // ── The exercise generator doesn't depend on what the tutor says, so when they have asked for one it runs IN PARALLEL with the
  //    tutor's own call (the longest wait in a turn) instead of after it. ──
  const levelText = [context.profile?.yearLevel, context.profile?.track === "ib" ? "IB Diploma" : context.profile?.track === "ap" ? "AP" : context.profile?.track === "bac" ? "baccalauréat" : "", ...(context.profile?.courses || []).slice(0, 4)].filter(Boolean).join(", ");
  // Earlier sittings (the learner model) decide the level when the last few turns do not: proven mastery goes up, repeated failure goes down.
  const studentModel = (() => { try { return normalizeStudentModel(context.profile?.conceptModel); } catch { return undefined; } })();
  const conceptRec = (t: string) => (t && studentModel ? findConcept(studentModel, t) : undefined);
  const modelDifficulty = (d: "easier" | "at_level" | "harder", t: string) => {
    const rec = conceptRec(t);
    if (d !== "at_level" || !rec || rec.attempts < 3) return d;
    return independentSuccess(rec) >= 0.75 ? "harder" : independentSuccess(rec) <= 0.25 ? "easier" : d;
  };
  const buildGenRequest = (spokenText: string) => {
    const topic = objectives.find((o) => !o.done)?.label || [...board].reverse().find((b) => b.kind === "focus" && b.text)?.text || context.subject || "";
    const used = exercisesSoFar({ history, problems, memory: context.memory, board });
    // What was actually SET counts, not just what was said: an exercise lives in the widget, so the chat text rarely shows its
    // kind (every follow-up came out as multiple choice in the baseline run). A free-response exercise is a "compute".
    const kinds = [...recentQuestionKinds(history), ...problems.slice(-3).map((p) => (p.options?.length ? questionKind(p.question) : "compute"))].slice(-6);
    const lastTwoMcq = problems.length >= 2 && problems.slice(-2).every((p) => p.options?.length);
    const nextKind = lastTwoMcq && !isDiscussionSubject(context.subject, spokenText) ? "compute" : (["compute", "explain_why", "spot_error", "predict", "compare", "sketch"] as const).find((k) => !kinds.includes(k)) ?? "any";
    return {
      subject: context.subject, topic: wants.different ? "" : topic, level: levelText, difficulty: difficultyAsked(message) ?? modelDifficulty(difficultyFrom(input.teaching?.log), topic), probe: conceptRec(topic) ? liveMisconceptions(conceptRec(topic)!, new Date())[0]?.text : undefined,
      kind: (wants.exercise && !/\b(?:err|mistake|wrong|why|explain|erreur|faute|pourquoi|expliq)/i.test(message) ? "compute" : isDiscussionSubject(context.subject, spokenText) && nextKind === "compute" ? "explain_why" : nextKind) as any,
      openers: history.filter((h) => h.role === "assistant").slice(-4).map((h) => h.text.toLowerCase().replace(/[^a-zà-ÿ' ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).join(" ")).filter(Boolean),
      used, lang: (fr ? "fr" : "en") as "fr" | "en", ask: wants.exercise || wants.different ? message.slice(0, 200) : undefined,
      announced: spokenText !== message ? spokenText.split(/(?<=[.!?])\s+/).filter((sn) => !/\?\s*$/.test(sn)).join(" ") : undefined,
      allowedTopics: objectives.map((o) => o.label), scope,
      recent: { student: message.startsWith("[") ? undefined : message, tutor: [...history].reverse().find((h) => h.role === "assistant")?.text },
    };
  };
  const genTokens = { in: 0, out: 0, cachedIn: 0 };
  const earlyGen = !wants.problemOnBoard && (wants.exercise || wants.different) ? generateProblem(buildGenRequest(message), genTokens).catch(() => null) : null;

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

  // What this very turn learned counts: a first message that already says what they want and when allows the plan right away.
  if (turn.goals) vctx.goalsKnown = goalsKnown(mergeGoals(input.teaching?.goals, turn.goals, false), message, objectives.length > 0);
  // A solve that ran alongside the tutor's call is needed from here on (leak checks, the verdicts, the answer key).
  if (input.solutionPromise) {
    const sol = await input.solutionPromise.catch(() => null);
    if (sol) { input = { ...input, solution: sol }; vctx.solution = sol; vctx.said.push(sol.statement); }
  }

  // ── Verify, repair once, then fix in code what's left ──
  let issues: Issue[] = verifyTurn(turn, vctx);
  // When the generator is writing the exercise, the tutor's reply is only a lead-in: checks about the exercise itself (is it there,
  // is it new, are its numbers the student's) are about text that won't be shown, so they must not cost a repair call.
  if (earlyGen) issues = issues.filter((i) => !["intent_exercise", "vague", "repeat_exercise", "numbers", "invented_object", "length"].includes(i.code));
  if (worthFactChecking(turn.move, turn.speech, turn.diagnosis.status)) {
    const bad = await falseClaim(turn.speech, turn.board.map((o: any) => String(o.text || "")).filter(Boolean), { subject: context.subject, problem: problems.find((p) => !p.solved)?.question || input.solution?.statement, student: message, recent: history.slice(-4).map((h) => `${h.role === "user" ? "Student" : "Tutor"}: ${h.text}`).join(" / ") }, result.tokens);
    if (bad) issues.push({ code: "fact", hard: true, fix: `a claim looks FALSE: ${bad}. Correct it (or leave it out) — only say what is true.` });
  }
  let repaired = false;
  const firstIssues = issues.map((i) => i.code);
  // A repair is a whole extra model call: worth it for a hard problem or several soft ones; a single soft issue is fixed in code.
  if (issues.some((i) => i.hard) || issues.length >= 2) {
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
  let exerciseIntended = false;
  const studentStatedProblem = studentProblemStatement(message);
  {
    const speechAll = turn.speech.join(" ");
    // A reply that announces a task ("Let's examine a student's solution…", "Now let's check your intuition…") with nothing placed for it:
    // the app builds the task itself, so they never have to ask "so what is it?".
    const lastSn = turn.speech[turn.speech.length - 1] || "";
    const announces = /\b(?:find|spot|catch|check|fix|look at|hunt for)\b[^.?!]{0,25}\b(?:slip|mistake|error|working|solution|line)\b/i.test(lastSn) && !/\?\s*$/.test(lastSn) && !turn.board.some((o) => o.op === "problem" || o.op === "gap" || o.op === "draw" || (o.op === "step" && o.kind === "given")) || /(?:^|[—–,;:]\s*|\.\s+)(?:(?:now|next|so|ok(?:ay)?|alright)[, ]+)*(?:let'?s|let us|time to|on to|next (?:one|up|problem|exercise|question)\b|(?:here'?s|here is) (?:one|another|a (?:new|fresh|harder|trickier|similar|different) (?:one|problem|exercise|question)))\b/i.test(lastSn) && !/\?\s*$/.test(lastSn)
      && !turn.speech.some((sn) => /\?\s*$/.test(sn)) && !turn.board.some((o) => o.op === "problem" || o.op === "gap" || o.op === "draw" || (o.op === "step" && o.kind === "given"));
    const newExercise = !wants.problemOnBoard && (wants.exercise || wants.different || turn.move === "practice" || announces);
    exerciseIntended = newExercise;
    // They asked for a new exercise: an unsolved earlier one is set aside, it must not block the new one (it was silently dropped before).
    if (newExercise && (wants.exercise || wants.different)) problemsForApply = problems.map((p) => ({ ...p, solved: true }));
    if (newExercise) {
      let gen: Awaited<ReturnType<typeof generateProblem>> = null;
      if (earlyGen) {
        gen = await earlyGen; // started before the tutor's own call, so its wait overlapped
        result.tokens.in += genTokens.in; result.tokens.out += genTokens.out; result.tokens.cachedIn += genTokens.cachedIn;
      } else gen = await generateProblem(buildGenRequest(speechAll), result.tokens);
      // One more, plainer try before giving up: any kind of task, nothing but the subject and level to satisfy.
      if (!gen) gen = await generateProblem({ ...buildGenRequest(speechAll), kind: "any", scope: undefined, allowedTopics: undefined, used: buildGenRequest(speechAll).used.slice(-4) }, result.tokens);
      if (gen) {
        // The widget carries the problem text; the speech keeps only the lead-in (the sentences before the problem is stated).
        // The problem starts at the first sentence with a number from which the rest of the reply poses a problem.
        const at = turn.speech.findIndex((sn, i) => /\d/.test(sn) && (statesAProblem(turn!.speech.slice(i).join(" ")) || (/\?\s*$/.test(sn) && countWordsLite(sn) >= 8)));
        const scopeWithGen = new Set([...scope, ...contentWords(`${gen.topic} ${String(gen.input.question || "")}`)]);
        // Lead-in sentences must be about this session: "let's switch to macroeconomics" in a physics session goes.
        const stays = (sn: string) => !/\d/.test(sn) && !DESCRIBES_EXERCISE.test(sn) && (contentWords(sn).length < 3 || inScope(sn, scopeWithGen, Math.ceil(contentWords(sn).length / 3)));
        let speech = (at >= 0 ? turn.speech.slice(0, at) : turn.speech.filter((sn) => !/\?\s*$/.test(sn))).filter(stays);
        if (!speech.length || !/[.!?]\s*$/.test(speech[speech.length - 1])) speech = [...speech, gen.intro];
        else if (!speech.some((sn) => sn === gen.intro) && !/\b(?:try|work out|find|what|which|how)\b/i.test(speech[speech.length - 1])) speech = [...speech, gen.intro];
        // The tutor's own lead-in and the generator's intro often say the same thing twice ("Both chain-rule questions clean… Both chain-rule questions clean…"): keep the later one.
        speech = speech.filter((sn, i) => !speech.slice(i + 1).some((later) => similarity(sn, later) >= 0.55 || sharesWordRun(sn, later, 4)));
        const ops = turn.board.filter((o) => o.op !== "problem" && !(wants.different && o.op === "topic"));
        if (wants.different && gen.topic) ops.unshift({ op: "topic", cue: 0, text: gen.topic });
        ops.push({ op: "problem", cue: Math.max(0, speech.length - 1), ...(gen.input as any) });
        turn = { ...turn, speech, board: ops.map((o) => ({ ...o, cue: Math.min(o.cue, Math.max(0, speech.length - 1)) })), expects: "value" };
        if (wants.different) problemsForApply = problems.map((p) => ({ ...p, solved: true }));
      } else console.warn("[tutor] problem generator returned nothing — keeping the tutor's own exercise, if any");
    } else if (!wants.problemOnBoard && studentStatedProblem && input.solution?.verified && Number.isFinite(input.solution.value) && sameExercise(input.solution.statement, studentStatedProblem, 0.5) && !problems.some((p) => sameExercise(p.question, studentStatedProblem, 0.6)) && !turn.board.some((o) => o.op === "problem")) {
      // They typed a problem of their own: it goes into the answer widget with the solver's code-verified key, not just chat text.
      const ops = [...turn.board, { op: "problem", cue: Math.max(0, turn.speech.length - 1), question: studentStatedProblem, answer: input.solution.finalAnswer, check: String(input.solution.value), format: "a number (units as in the problem)" } as any];
      turn = { ...turn, board: ops };
      problemsForApply = problems.map((p) => ({ ...p, solved: true }));
    } else if (wants.problemOnBoard) {
      // A problem that already exists (Otto stated it, or they pasted it): the widget gets it with a code-verified key from the solver.
      const text = problemStatement({ opQuestion: turn.board.find((o) => o.op === "problem")?.question, history: [...history, { role: "assistant", text: speechAll }], openProblem: [...problems].reverse().find((p) => !p.solved)?.question, studentStated: studentProblemStatement(message) });
      if (text && !problems.some((p) => !p.solved && sameExercise(p.question, text, 0.7))) {
        let sol = input.solution && sameExercise(input.solution.statement, text, 0.6) ? input.solution : null;
        if (!sol) { const solved = await solveProblem(text, context.subject); result.tokens.in += solved.tokens.in; result.tokens.out += solved.tokens.out; sol = solved.solution; }
        const wordKey = sol?.verified && !Number.isFinite(sol.value) && String(sol.finalAnswer || "").trim().length > 0 && !/\d/.test(String(sol.finalAnswer));
        if ((sol?.verified && Number.isFinite(sol.value)) || wordKey) {
          const ops = turn.board.filter((o) => o.op !== "problem");
          ops.push({ op: "problem", cue: Math.max(0, turn.speech.length - 1), question: text, answer: sol!.finalAnswer, ...(Number.isFinite(sol!.value) ? { check: String(sol!.value), format: "a number (units as in the problem)" } : { format: "a short answer" }) } as any);
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
  // A teaching reply that SAYS an equation ("so $12 = 6v$") puts it on the board, whatever the model did: speech passes, the board is what stays.
  if (["explain", "worked_step", "worked_example", "correct_error", "hint_procedure"].includes(turn.move) && !applied.board.some((e) => e.kind !== "focus" && e.kind !== "annotation" && e.kind !== "given")) {
    const norm = (x: string) => x.replace(/[\s\\{}$]/g, "").toLowerCase();
    const onBoard = [...board, ...applied.board].map((e) => norm(e.text || "")).join("|");
    const spoken = [...turn.speech.join(" ").matchAll(/\$([^$]{3,70}=[^$]{1,70})\$/g)].map((m) => m[1].trim()).find((q) => !/\?/.test(q) && !onBoard.includes(norm(q)));
    if (spoken && !revealsKey(spoken, vctx)) {
      const r = applyOps([{ op: "step", cue: Math.max(0, turn.speech.length - 1), text: `$${spoken}$`, kind: "result" }], { message, theirWords, board: [...board, ...applied.board], problems, fr });
      applied.board.push(...r.board);
    }
  }
  // THE PROBLEM IS ON THE BOARD whatever the model did: asked for it, or Otto just stated a new one in words only.
  {
    const placed = applied.board.some((e) => e.kind === "given") || applied.problems.length > 0;
    const speechAll = turn.speech.join(" ");
    const freshScenario = posesProblemInProse(speechAll) && /\b(?:picture|imagine|suppose|consider|take|say|let'?s say|here'?s|if|a|an)\b[^.?!]{0,14}\ban?\s+\d/i.test(speechAll) && (() => { const nums = speechAll.match(/\d+(?:\.\d+)?/g) || []; const known = [...problems.filter((p) => !p.solved).map((p) => p.question || ""), ...board.map((b) => b.text || "")].join(" "); return nums.length >= 2 && nums.filter((n) => !new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}(?![\\d])`).test(known)).length >= 2; })();
    const statesNew = posesProblemInProse(speechAll) && (((wants.exercise || wants.different) && !problems.some((p) => !p.solved)) || wants.topicSwitch || freshScenario);
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
  else if (wants.topicSwitch && objectives.length) result.objectives = []; // the old plan belongs to the topic they left
  else if (purgedObjectives) {
    // The stored plan is replaced by its on-topic part; if nothing is left, by one goal taken from the session's own worksheet.
    const header = [...board].reverse().find((b) => b.kind === "focus" && b.text && inScope(b.text, baseScope))?.text;
    const fallback = cleanObjs.length ? cleanObjs : header ? [{ id: `obj-${Date.now().toString(36)}`, label: String(header).replace(/\$/g, "").slice(0, 48), done: false }] : [];
    if (fallback.length) result.objectives = fallback as any;
  }
  if (applied.dropped.length) console.log(`[tutor] dropped ops: ${applied.dropped.join(" | ")}`);

  // They were promised an exercise and none was placed (the generator failed twice, or the board refused it): the reply must not say
  // "here is a new problem" over nothing.
  if (exerciseIntended && !applied.problems.length && !applied.board.some((e) => e.kind === "given")) {
    const claimsExercise = (sn: string) => /\b(?:new|another|fresh|next|different)\s+(?:problem|exercise|question)\b|\bhere(?:'s| is| are)\b[^.?!]*\b(?:problem|exercise|question)\b|\b(?:check|test) (?:your|our) understanding\b|\b(?:la |le |les )?(?:voil[àa]|voici)\b|\b(?:nouvel|autre|prochain)e?\s+(?:exercice|probl[èe]me|question|[ée]quation)\b/i.test(sn);
    if (turn.speech.some(claimsExercise)) {
      const kept = turn.speech.filter((sn) => !claimsExercise(sn));
      if (kept.length && kept.some((sn) => /\?\s*$/.test(sn))) turn = { ...turn, speech: kept };
      else {
        const text = await rewriteReply(turn.speech.join(" "), "the exercise didn't come out: say so in one short natural sentence, then carry on yourself with ONE question on the same topic they are on right now (don't ask them what to study next, and don't describe an exercise)", message, result.tokens);
        if (text) turn = { ...turn, speech: [text] };
      }
    }
    if (applied.dropped.length) console.warn(`[tutor] exercise not placed: ${applied.dropped.join(" | ")}`);
  }

  // A lead-in with nothing after it ("Now let's check your intuition about …") while no exercise, gap or question was placed: the reply
  // must end on something they can answer.
  {
    const last = turn.speech[turn.speech.length - 1] || "";
    const placedSomething = applied.problems.length > 0 || applied.board.some((e) => e.kind === "gap" || e.kind === "given");
    const dangling = /^\s*(?:(?:now|next|so|ok(?:ay)?|alright)[, ]+)*(?:let'?s|let us|time to|on to)\b/i.test(last) && !/\?\s*$/.test(last);
    if (dangling && !placedSomething && !turn.speech.some((sn) => /\?\s*$/.test(sn))) {
      const text = await rewriteReply(turn.speech.join(" "), "the reply announces something to do ('let's check…') but never asks it — keep what it said and end with ONE concrete question about the current topic that they can answer now", message, result.tokens);
      if (text && /\?\s*$/.test(text.trim())) turn = { ...turn, speech: [text] };
    }
  }

  // The board ops can still fail to build (a bad figure spec, a duplicate): then the speech must not claim them.
  const visualNow = hasVisual([...board, ...applied.board]);
  if (turn.speech.some((sn) => claimsBoard(sn, visualNow)) && !applied.board.some((e) => e.kind !== "annotation" && e.kind !== "focus") && !applied.problems.length) {
    const kept = turn.speech.filter((s) => !claimsBoard(s, visualNow));
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
    speech: turn.speech, goals: mergeGoals(input.teaching?.goals, turn.goals, !vctx.goalsKnown && !applied.objectives), ...(turn.angle ? { angle: turn.angle } : {}), ...(turn.diagnosis.misconception ? { misconception: turn.diagnosis.misconception } : {}), move: turn.move, support: MOVE_SUPPORT[turn.move], intent: turn.intent, diagnosis: turn.diagnosis.status,
    repaired, issues: firstIssues, dropped: applied.dropped, ms: Date.now() - t0, struggled: struggled && !progressed, ...(verdict ? { verdict } : {}),
  };
  return result;
}

export type { TurnOutput };
export type { BoardEntry, TaskObjective, TaskProblem, TutorSolution };
