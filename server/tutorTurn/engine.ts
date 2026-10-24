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
type Msg = { role: "system" | "user" | "assistant"; content: string };

/** Everything the model is told before the conversation: who Otto is, the student, the board as it stands, research, earlier context. */
function buildSystemPrompt(input: TutorTurnInput, checked: string | null): string {
  const { message, history, board, problems, context } = input;
  const spokenRepair: SpokenRepair | null = input.spoken ? repairSpokenMath(message, spokenContextFrom([context.subject || "", ...board.map((b) => b.text || "")])) : null;
  return TURN_PROMPT
    + DRAW_REFERENCE
    + (input.voiceMode ? VOICE_NOTE : "")
    + backgroundBlock(context)
    + `\n\nToday is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`
    + `\n\nTHE BOARD (margin numbers #n are what you point at)${boardSurfaceBlock(board, problems) || ": empty."}`
    + researchBlock(input.research)
    + earlierInSitting(history)
    + (checked ? `\n\nCHECKED BY CODE-LIKE RECOMPUTATION (trust this over your own quick reading of their message): ${checked}` : "")
    + (input.spoken && spokenRepair ? voiceInputBlock(message, input.spoken.alternatives, spokenRepair) : "")
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
  const t0 = Date.now();
  const deadline = t0 + TURN_HARD_MS;
  const soft = () => Date.now() < t0 + TURN_SOFT_MS;
  const { message, history, board } = input;
  const result: TutorTurnResult & { turn?: { speech: string[]; ms: number } } = { reply: "", board: [], problems: [], tokens: { in: 0, out: 0, cachedIn: 0 }, guardrailTripped: false };

  // Real working in the message: a second reader recomputes it first, so Otto neither praises a slip nor asks them to redo a step.
  const checked = carriesWorking(message) && soft() ? await checkWork(message, board.map((b) => b.text || "").filter(Boolean), result.tokens) : null;
  const messages: Msg[] = [
    { role: "system", content: buildSystemPrompt(input, checked) },
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

  const { turn, applied } = await ensureBoardWritten(first, { input, messages, tokens: result.tokens, deadline, soft });
  const sources = input.researchFresh ? sourcesNote(input.research) : null;
  result.board = sources ? [sources, ...applied.board] : applied.board;
  result.reply = turn.speech.join(" ");
  result.turn = { speech: turn.speech, ms: Date.now() - t0 };
  console.log(`[tutor] turn ${result.turn.ms}ms tokens in=${result.tokens.in} out=${result.tokens.out} cached=${result.tokens.cachedIn} board=${applied.board.length}`); // (counts only: never the text)
  return result;
}

export type { TurnOutput };
export type { BoardEntry, TaskObjective, TaskProblem };
