// ONE TUTOR TURN: the prompt (who Otto is + the board as it stands) and the conversation go to the model once; it answers {speech, board};
// the board ops become board entries (apply.ts). Three small, time-boxed extras exist: a working check before the reply, a JSON re-ask, and a
// board nudge when the words and the board disagree. No fixed replies and no repair of the model's wording: every word the student reads is
// the model's own.
import type { BoardEntry, TaskObjective, TaskProblem } from "../../shared/types.ts";
import { normalizeTurn, extractJsonObject, salvageTurn, type TurnOutput } from "../../shared/tutorTurn.ts";
import { repairSpokenMath, spokenContextFrom, type SpokenRepair } from "../../shared/spokenMath.ts";
import { boardSurfaceBlock } from "../boardEvents.ts";
import { createTutorChat, retryRequest, usageOf, classifyProviderError, makeBoardEntry } from "../claude.ts";
import { voiceInputBlock } from "../tutorAdapt.ts";
import { backgroundBlock, type TutorTurnInput, type TutorTurnResult } from "../tutor.ts";
import { TURN_PROMPT, VOICE_NOTE, DRAW_REFERENCE } from "./prompt.ts";
import { applyOps, type Applied } from "./apply.ts";
import { carriesWorking, checkWork } from "./check.ts";
import { researchBlock } from "./research.ts";
import { checkSpokenTurn, spokenCheckNote } from "./spokenCheck.ts";
import { boardListing } from "../../shared/boardTool.ts";
import { solveProblem } from "../solver.ts";
import type { TutorSolution } from "../../shared/types.ts";

const MAX_HISTORY = 14;
/** A turn is a few sentences plus a few board ops; this caps a runaway reply (and its cost), not a normal one. */
const TURN_MAX_TOKENS = 2500;
/** One deadline for the WHOLE turn (check + reply + any retries), not per call: a turn can never outlive the one-turn-at-a-time lock (110 s)
 *  or a serverless function. After the soft budget only the reply itself is attempted — no extra checks, JSON re-asks or board nudges. */
const TURN_HARD_MS = Number(process.env.TUTOR_TURN_HARD_MS) || 55_000;
const TURN_SOFT_MS = Number(process.env.TUTOR_TURN_SOFT_MS) || 30_000;

async function callTurn(messages: { role: string; content: string }[], tokens: TutorTurnResult["tokens"], deadline: number): Promise<{ turn: TurnOutput | null; raw: string }> {
  const ask = (json: boolean) => retryRequest(() => createTutorChat({ max_tokens: TURN_MAX_TOKENS, temperature: 0.5, messages, ...(json ? { response_format: { type: "json_object" } } : {}) }, true, { deadline }), 2, 400);
  let res: any;
  // JSON mode first; a provider that rejects the parameter gets the same request without it (the prompt asks for JSON anyway).
  try { res = await ask(true); } catch (e: any) { if (Number(e?.status) === 400) res = await ask(false); else throw e; }
  const u = usageOf(res); tokens.in += u.in; tokens.out += u.out; tokens.cachedIn += u.cachedIn;
  const raw = String(res?.choices?.[0]?.message?.content || "");
  // Prose instead of JSON still beats an error: it is spoken as it is.
  return { turn: normalizeTurn(extractJsonObject(raw)) ?? normalizeTurn(salvageTurn(raw, { prose: true })), raw };
}

const WRITING_CLAIM = /\b(?:(?:let(?:'s| us)|let me|i(?:'ll| will)|i'm going to|now)\s+(?:get|put|write|jot|draw|add|set)\b[^.?!]{0,40}\b(?:board|down|up)\b|(?:on|to|onto) the board|i(?:'ve| have) (?:written|put|added|drawn))/i;
const ASKS_BOARD = /\b(?:on|onto|to) the (?:board|whiteboard|paper)\b|\bwrite (?:it|that|this|everything|the)\b|\bput (?:it|that|this) (?:up|down|on)\b/i;
const POINTS_AT_BOARD = /\b(?:here(?:'s| is| are)|we have|we got|this|these|that|the following|look at|see)\b[^.?!]{0,40}\b(?:equation|expression|formula|identity|figure|graph|diagram|curve|triangle|step|line|inequality|function)\b/i;

/** A second reader before the student hears it: the reply is checked against the charter (gave the result, agreed to a non-answer, false maths,
 *  steered off their route, stock praise). When something is found the model gets one chance to write the turn again without it, in its own
 *  words: nothing is ever replaced with fixed text. After the soft budget the turn goes out as it is. */
async function gateTurn(first: TurnOutput, args: { input: TutorTurnInput; messages: Msg[]; tokens: Tokens; deadline: number; soft: () => boolean }): Promise<TurnOutput> {
  const { input, messages, tokens, deadline, soft } = args;
  if (process.env.TUTOR_GATE === "off" || !soft() || !first.speech.length) return first;
  try {
    const recent = input.history.slice(-6).filter((h) => h.text?.trim()).map((h) => `${h.role === "user" ? "Student" : "Tutor"}: ${h.text.replace(/\s+/g, " ").slice(0, 400)}`);
    const exchange = [...recent, `Student: ${input.message.replace(/\s+/g, " ").slice(0, 500)}`, `Tutor: ${first.speech.join(" ")}`].join("\n");
    // Only a substantive slip is worth a second full model call (which adds seconds and a stiffer reply); cosmetic ones are let through.
    const flags = (await checkSpokenTurn({ exchange, listing: boardListing(input.board) }, tokens)).filter((f) => f.kind === "falseMath" || (f.kind === "gaveResult" && NAMES_A_RESULT.test(first.speech.join(" "))));
    if (!flags.length || !soft()) return first;
    const note = spokenCheckNote(flags, { rewrite: true });
    const again = await callTurn([...messages, { role: "assistant" as const, content: JSON.stringify(first) }, { role: "user" as const, content: `(${note} Send the turn again as ONLY the JSON object. The board ops must not contain what you were told not to say.)` }], tokens, deadline);
    if (again.turn?.speech.length) console.log(`[tutor] gate rewrote the turn: ${flags.map((f) => f.kind).join(",")}`);
    return again.turn?.speech.length ? again.turn : first;
  } catch { return first; }
}

/** The start of a long sitting, kept for free (no model call): only the last MAX_HISTORY messages are sent, so the first thing the student
 *  asked for and a few of their older messages ride along as one short block. Empty while the whole conversation still fits. */
export function earlierInSitting(history: { role: "user" | "assistant"; text: string }[]): string {
  if (history.length <= MAX_HISTORY) return "";
  const older = history.slice(0, history.length - MAX_HISTORY).filter((h) => h.role === "user" && h.text?.trim());
  if (!older.length) return "";
  const pick = [older[0], ...older.slice(1).filter((_, i, a) => i >= a.length - 4)];
  return `\n\nEARLIER IN THIS SITTING (older messages are not repeated; their first request was the goal, keep it in mind): ${pick.map((h) => `"${h.text.replace(/\s+/g, " ").slice(0, 140)}"`).join(" · ")}`;
}

type Tokens = TutorTurnResult["tokens"];

/** The problem the student is working on: what is pinned on the board as "given", else the first long thing they asked (their opening request). */
export function problemStatement(input: Pick<TutorTurnInput, "board" | "history" | "message">): string {
  const given = [...input.board].reverse().find((b) => b.kind === "given" && (b.text || "").length >= 25);
  if (given?.text) return given.text.slice(0, 1200);
  const mine = [...input.history.filter((h) => h.role === "user").map((h) => h.text || ""), input.message];
  const first = mine.find((t) => t.trim().length >= 80);
  return (first || "").trim().slice(0, 1200);
}

const solved = new Map<string, { sol: TutorSolution | null; agree: boolean }>();
const solving = new Map<string, Promise<{ sol: TutorSolution | null; agree: boolean }>>(); // in flight: a later turn joins the same solve instead of starting another
const flat = (t: string) => String(t || "").toLowerCase().replace(/[^a-z0-9.]+/g, "");
const sameAnswer = (a: string, b: string) => { const x = flat(a), y = flat(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
/** Started in the background and NEVER waited for (ms = 0): a reply is never slowed by it; from the turn after it finishes, the tutor has it.
 *  An independent solution of the problem, solved twice with the model's thinking ON (the second pass told to hunt for the trap; the fast no-thinking mode fell for trick questions) so a single confident slip cannot become the
 *  tutor's "truth". Cached per statement in this instance. Never throws and never holds the turn past `ms`. */
async function referenceSolution(input: TutorTurnInput, tokens: Tokens, ms: number): Promise<{ sol: TutorSolution | null; agree: boolean }> {
  if (input.solution) return { sol: input.solution, agree: true };
  const statement = problemStatement(input);
  if (!statement || process.env.TUTOR_SOLVE === "off") return { sol: null, agree: true };
  const key = statement.toLowerCase().replace(/\s+/g, " ").slice(0, 400);
  const hit = solved.get(key);
  if (hit) return hit;
  const running = solving.get(key);
  if (running) return Promise.race([running, new Promise<{ sol: null; agree: boolean }>((res) => setTimeout(() => res({ sol: null, agree: true }), ms))]);
  const add = (t: Tokens) => { tokens.in += t.in; tokens.out += t.out; tokens.cachedIn += t.cachedIn; };
  const run = Promise.all([solveProblem(statement, input.context.subject, { think: true }), solveProblem(statement, input.context.subject, { hunt: true, think: true })]).then(([a, b]) => {
    add(a.tokens); add(b.tokens);
    const sol = a.solution || b.solution;
    const agree = !!a.solution && !!b.solution && sameAnswer(a.solution.finalAnswer, b.solution.finalAnswer);
    // On disagreement prefer the pass that was told to hunt for the trap, but mark the whole thing uncertain.
    const out = { sol: agree ? a.solution : (b.solution || sol), agree };
    solved.set(key, out); if (solved.size > 60) solved.delete(solved.keys().next().value as string);
    return out;
  }).catch(() => ({ sol: null, agree: true })).finally(() => { solving.delete(key); });
  solving.set(key, run);
  return Promise.race([run, new Promise<{ sol: null; agree: boolean }>((res) => setTimeout(() => res({ sol: null, agree: true }), ms))]);
}

function referenceBlock(ref: { sol: TutorSolution | null; agree: boolean }): string {
  const sol = ref.sol;
  if (!sol) return "";
  if (!ref.agree) return `\n\nTHEIR PROBLEM IS A POSSIBLE TRAP AND TWO INDEPENDENT SOLVES DISAGREED, so you do NOT know the answer. Do not confirm or hint at any option or result yet. If they asked you to explain, begin by explaining the DEFINITIONS that decide it (the exact quantity asked: done by which force or agent, on what, over what displacement of its own point of application; net versus one part), in plain words and without naming an option, then let them apply it. Work each claim out from first principles as you say it. Once the definitions settle the question and the student has reasoned their way there, confirm it plainly and say why, and what the tempting wrong options mistook. One attempt led to: ${sol.finalAnswer}${sol.mistakes?.length ? ` (traps: ${sol.mistakes.join(" | ")})` : ""}: treat that as a lead to test, not a fact.`;
  const steps = sol.steps.map((x, i) => `  ${i + 1}. ${x.idea}${x.result ? ` → ${x.result}` : ""}`).join("\n");
  return `\n\nREFERENCE SOLUTION OF THEIR PROBLEM (two independent reasoning attempts agreed${sol.verified ? "; numbers checked by code" : "; not fully verified"}; for YOUR accuracy). Answer: ${sol.finalAnswer}\n${steps ? `Steps:\n${steps}\n` : ""}${sol.keyIdea ? `Key idea: ${sol.keyIdea}\n` : ""}${sol.mistakes?.length ? `Traps and common mistakes: ${sol.mistakes.join(" | ")}\n` : ""}This is a strong lead from an independent solver, NOT the truth: solvers fall for trick questions. Before you assert or confirm any conclusion, test it against the DEFINITION of the exact quantity asked (done by which force or agent, on what, over what displacement of its own point of application; net versus one part). If your own derivation from the definition disagrees with this reference, trust the derivation, say you are double-checking, and work it through with the student. Their reasoning can be right while the answer they head to is wrong, or the reverse. The reference is for your accuracy, not for announcing: until the student has reasoned their own way to the answer, never name the option letter, the final value or the decisive step; steer them there with explanation and one good question, and confirm only after they have said it.`;
}
/** The last thing the model reads. The reference blocks above (the IB pack with its own "before every reply" checklist, the solver notes) are long and
 *  written as rules; left as the final word they turned replies into exam drills ("hi" was answered with "AA or AI, SL or HL?"). */
const LAST_WORD = `\n\nLAST, AND ABOVE EVERY CHECKLIST ABOVE: answer THIS message the way a good human tutor beside them would. What did they just say, and how are they? Respond to that first (a hello, thanks, a joke, "I'm tired" get a human answer, not maths). Do not ask for their course or level before helping; ask in passing only when the answer would change what you teach. No marks, command terms or mark-scheme talk unless they are practising for marks or asked. If they ask for a quick practice question, give ONE short single-part question on exactly the idea you were just discussing (whatever the notes above say about exam-style parts; a bank question only if it is about that very idea). Say something you have not said yet, the size the moment needs, and stop when you have said it: a question at the end only when it helps them. When they are right, the word is "yep" or "right": never open with "Spot on", "Exactly" or "You nailed it".`;
/** "Gave the result" needs a result in the reply: a value (in digits or spoken words), an equation or a named option. Without one the flag is the judge misreading a plain
 *  explanation, and the rewrite turned "i don't get why that led to a war" into a question back instead of the explanation they asked for. */
const NAMES_A_RESULT = /[\d=$]|\b(?:option|answer is|it(?:'s| is) [A-E]|zero|one|two|three|four|five|six|seven|eight|nine|ten|half|third|quarter|squared|cubed|root|minus|plus|times|over|equals?)\b/;
type Msg = { role: "system" | "user" | "assistant"; content: string };

/** Everything the model is told before the conversation: who Otto is, the student, the board as it stands, research, earlier context. */
function buildSystemPrompt(input: TutorTurnInput, checked: string | null, reference: { sol: TutorSolution | null; agree: boolean } = { sol: null, agree: true }): string {
  const { message, history, board, problems, context } = input;
  const spokenRepair: SpokenRepair | null = input.spoken ? repairSpokenMath(message, spokenContextFrom([context.subject || "", ...board.map((b) => b.text || "")])) : null;
  return TURN_PROMPT
    + DRAW_REFERENCE
    + (input.voiceMode ? VOICE_NOTE : "")
    + backgroundBlock(context)
    + `\n\nToday is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`
    + `\n\nTHE BOARD (margin numbers #n are what you point at)${boardSurfaceBlock(board, problems) || ": empty."}`
    + researchBlock(input.research)
    + referenceBlock(reference)
    + earlierInSitting(history)
    + (checked ? `\n\nCHECKED BY CODE-LIKE RECOMPUTATION (trust this over your own quick reading of their message): ${checked}` : "")
    + (input.spoken && spokenRepair ? voiceInputBlock(message, input.spoken.alternatives, spokenRepair) : "")
    + LAST_WORD
    + `\n\nReply in English unless the student writes in another language. Return ONLY the JSON object.`;
}

/** The model's turn, with one re-ask when it did not return the JSON object (skipped once the soft budget is spent). */
async function askForTurn(messages: Msg[], tokens: Tokens, deadline: number, mayRetry: () => boolean): Promise<TurnOutput | null> {
  const first = await callTurn(messages, tokens, deadline);
  if (first.turn || !mayRetry()) return first.turn;
  const retry = [...messages, { role: "assistant" as const, content: first.raw.slice(0, 2000) }, { role: "user" as const, content: "(That wasn't the JSON object. Send the same turn again as ONLY the JSON object described above.)" }];
  return (await callTurn(retry, tokens, deadline)).turn;
}

/** The board must match the words. When a reply points at or claims a line it never wrote, the student asked for the board, or they gave maths
 *  and nothing was written, the turn goes back (twice at most) with what was wrong, including the ops the app rejected. A line that is already
 *  on the board counts as written, so that case costs nothing. */
async function ensureBoardWritten(first: TurnOutput, args: { input: TutorTurnInput; messages: Msg[]; tokens: Tokens; deadline: number; soft: () => boolean }): Promise<{ turn: TurnOutput; applied: Applied }> {
  const { input, messages, tokens, deadline, soft } = args;
  const { message, board, problems } = input;
  const apply = (t: TurnOutput) => applyOps(t.board, { board, problems, theirWords: [message] });
  const needsBoard = (t: TurnOutput) => ASKS_BOARD.test(message) || POINTS_AT_BOARD.test(t.speech.join(" ")) || WRITING_CLAIM.test(t.speech.join(" ")) || (/[\d=]/.test(message) && message.length > 2);
  const alreadyThere = (a: Applied) => a.dropped.length > 0 && a.dropped.every((d) => /already|near-duplicate/.test(d));
  let turn = first, applied = apply(first);
  for (let attempt = 0; attempt < 2 && soft() && !applied.board.length && !alreadyThere(applied) && needsBoard(turn); attempt++) {
    const why = applied.dropped.length ? ` The app rejected these ops: ${applied.dropped.slice(0, 4).join("; ")}.` : "";
    const ask = ASKS_BOARD.test(message) ? " They asked for it on the board: write the most recent equation or step you and they reached, in full, as a step op." : "";
    const nudge = `(Nothing new reached the board.${why}${ask} Check: a step they reached, the rule or reason, a figure or table that would help, a mark on a mistake. Send the same turn again with the board ops that belong (anything you refer to must be written or drawn), each with its cue. If truly nothing belongs, return the same turn.)`;
    const again = await callTurn([...messages, { role: "assistant", content: JSON.stringify(turn) }, { role: "user", content: nudge }], tokens, deadline).catch(() => null);
    if (!again?.turn) break;
    turn = again.turn; applied = apply(turn);
    if (applied.board.length) break;
  }
  return { turn, applied };
}

/** The sources of the research done this turn, as one board note, so the student sees what the session is anchored on. */
function sourcesNote(research: TutorTurnInput["research"]): BoardEntry | null {
  if (!research?.sources.length) return null;
  const made = makeBoardEntry({ text: `Sources I looked at — ${research.topic}\n${research.sources.slice(0, 4).map((x) => `• ${x.title}: ${x.url}`).join("\n")}`, kind: "note", owner: "otto" });
  return "error" in made ? null : made.entry;
}

export async function runTutorTurn(input: TutorTurnInput): Promise<TutorTurnResult & { turn?: { speech: string[]; ms: number } }> {
  const tStart = Date.now();
  let t0 = tStart, deadline = t0 + TURN_HARD_MS;
  const soft = () => Date.now() < t0 + TURN_SOFT_MS;
  const { message, history, board } = input;
  const result: TutorTurnResult & { turn?: { speech: string[]; ms: number } } = { reply: "", board: [], problems: [], tokens: { in: 0, out: 0, cachedIn: 0 }, guardrailTripped: false };

  // Real working in the message: a second reader recomputes it first, so Otto neither praises a slip nor asks them to redo a step.
  const [checked, reference] = await Promise.all([
    carriesWorking(message) && soft() ? checkWork(message, board.map((b) => b.text || "").filter(Boolean), result.tokens) : Promise.resolve(null),
    referenceSolution(input, result.tokens, 0),
  ]);
  // The reference solve (first turn of a problem only; cached after) has its own wait, so the reply keeps a full time budget.
  t0 = Date.now(); deadline = t0 + TURN_HARD_MS;
  const messages: Msg[] = [
    { role: "system", content: buildSystemPrompt(input, checked, reference) },
    ...history.slice(-MAX_HISTORY).filter((h) => h.text?.trim()).map((h) => ({ role: h.role, content: h.text.slice(0, 4000) })),
    { role: "user", content: message },
  ];

  let first: TurnOutput | null;
  try { first = await askForTurn(messages, result.tokens, deadline, soft); }
  catch (e: any) {
    result.errorKind = classifyProviderError(e);
    console.error(`[tutor] model request failed: ${result.errorKind}${e?.status ? ` ${e.status}` : ""}`); // (kind and status only: provider error bodies can echo prompt text)
    result.error = true;
    return result;
  }
  if (!first) { console.error("[tutor] no usable turn"); result.error = true; return result; }

  const gated = await gateTurn(first, { input, messages, tokens: result.tokens, deadline, soft });
  const ensured = await ensureBoardWritten(gated, { input, messages, tokens: result.tokens, deadline, soft });
  const turn = ensured.turn;
  const sources = input.researchFresh ? sourcesNote(input.research) : null;
  result.board = sources ? [sources, ...ensured.applied.board] : ensured.applied.board;
  result.reply = turn.speech.join(" ");
  result.turn = { speech: turn.speech, ms: Date.now() - tStart };
  console.log(`[tutor] turn ${result.turn.ms}ms tokens in=${result.tokens.in} out=${result.tokens.out} cached=${result.tokens.cachedIn} board=${ensured.applied.board.length}`); // (counts only: never the text)
  return result;
}

export type { TurnOutput };
export type { BoardEntry, TaskObjective, TaskProblem };
