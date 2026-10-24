// ONE TUTOR TURN (plus rare, time-boxed extras: a working check, a JSON re-ask, a board nudge): the prompt (who Otto is + the board as it stands) and the conversation go to the model once; it answers
// {speech, board}; the board ops become board entries (apply.ts). No fixed replies and no repair of the model's wording: every word
// the student reads is the model's own. The only code between is removing what must never be shown (empty replies, tool-call text).
import type { BoardEntry, TaskObjective, TaskProblem } from "../../shared/types.ts";
import { normalizeTurn, extractJsonObject, salvageTurn, type TurnOutput } from "../../shared/tutorTurn.ts";
import { repairSpokenMath, spokenContextFrom, type SpokenRepair } from "../../shared/spokenMath.ts";
import { boardSurfaceBlock } from "../boardEvents.ts";
import { createTutorChat, retryRequest, usageOf, classifyProviderError } from "../claude.ts";
import { voiceInputBlock } from "../tutorAdapt.ts";
import { backgroundBlock, type TutorTurnInput, type TutorTurnResult } from "../tutor.ts";
import { TURN_PROMPT, VOICE_NOTE, DRAW_REFERENCE } from "./prompt.ts";
import { applyOps } from "./apply.ts";
import { carriesWorking, checkWork } from "./check.ts";
import { researchBlock } from "./research.ts";
import { makeBoardEntry } from "../claude.ts";

const MAX_HISTORY = 14;
/** A turn is a few sentences plus a few board ops; this caps a runaway reply (and its cost), not a normal one. */
const TURN_MAX_TOKENS = 2500;
/** One deadline for the WHOLE turn (check + reply + any retries), not per call: a turn can never outlive the one-turn-at-a-time lock (110 s)
 *  or a serverless function. After the soft budget only the reply itself is attempted — no extra checks, JSON re-asks or board nudges. */
const TURN_HARD_MS = Number(process.env.TUTOR_TURN_HARD_MS) || 55_000;
const TURN_SOFT_MS = Number(process.env.TUTOR_TURN_SOFT_MS) || 30_000;

async function callTurn(messages: any[], tokens: TutorTurnResult["tokens"], deadline: number): Promise<{ turn: TurnOutput | null; raw: string }> {
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

export async function runTutorTurn(input: TutorTurnInput): Promise<TutorTurnResult & { turn?: { speech: string[]; ms: number } }> {
  const t0 = Date.now();
  const deadline = t0 + TURN_HARD_MS;
  const soft = () => Date.now() < t0 + TURN_SOFT_MS;
  const { message, history, board, problems, context } = input;
  const result: TutorTurnResult & { turn?: { speech: string[]; ms: number } } = { reply: "", board: [], problems: [], tokens: { in: 0, out: 0, cachedIn: 0 }, guardrailTripped: false };

  const spokenRepair: SpokenRepair | null = input.spoken ? repairSpokenMath(message, spokenContextFrom([context.subject || "", ...board.map((b) => b.text || "")])) : null;
  // Real working in the message: a second reader recomputes it before the tutor answers (so it neither praises a slip nor asks them to redo a step).
  const checked = carriesWorking(message) && soft() ? await checkWork(message, board.map((b) => b.text || "").filter(Boolean), result.tokens) : null;
  const canDraw = true; // Unlimited visual artifact drawing capabilities across all subjects
  const system = TURN_PROMPT
    + (canDraw ? DRAW_REFERENCE : "")
    + (input.voiceMode ? VOICE_NOTE : "")
    + backgroundBlock(context)
    + `\n\nToday is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`
    + `\n\nTHE BOARD (margin numbers #n are what you point at)${boardSurfaceBlock(board, problems) || ": empty."}`
    + researchBlock(input.research)
    + earlierInSitting(history)
    + (checked ? `\n\nCHECKED BY CODE-LIKE RECOMPUTATION (trust this over your own quick reading of their message): ${checked}` : "")
    + (input.spoken && spokenRepair ? voiceInputBlock(message, input.spoken.alternatives, spokenRepair) : "")
    + `\n\nReply in English unless the student writes in another language. Return ONLY the JSON object.`;
  const messages: any[] = [
    { role: "system", content: system },
    ...history.slice(-MAX_HISTORY).filter((h) => h.text?.trim()).map((h) => ({ role: h.role, content: h.text.slice(0, 4000) })),
    { role: "user", content: message },
  ];

  let turn: TurnOutput | null = null, raw = "";
  try {
    ({ turn, raw } = await callTurn(messages, result.tokens, deadline));
    if (!turn && soft()) ({ turn } = await callTurn([...messages, { role: "assistant", content: raw.slice(0, 2000) }, { role: "user", content: "(That wasn't the JSON object. Send the same turn again as ONLY the JSON object described above.)" }], result.tokens, deadline));
  } catch (e: any) {
    result.errorKind = classifyProviderError(e);
    console.error(`[tutor] model request failed: ${result.errorKind}${e?.status ? ` ${e.status}` : ""}`); // (kind and status only: provider error bodies can echo prompt text)
    result.error = true;
    return result;
  }
  if (!turn) { console.error("[tutor] no usable turn"); result.error = true; return result; }

  let cur: TurnOutput = turn;
  // The board must match the words. A reply that says it wrote something, a student who asked for it on the board, or maths from the
  // student with nothing written: the turn is sent back (twice at most) with what was wrong, including ops the app rejected.
  const claimsWriting = (t: TurnOutput) => POINTS_AT_BOARD.test(t.speech.join(" ")) || WRITING_CLAIM.test(t.speech.join(" "));
  const askedForBoard = ASKS_BOARD.test(message);
  const mathsFromStudent = /[\d=]/.test(message) && message.length > 2;
  let applied = applyOps(cur.board, { board, problems, theirWords: [message] });
  // Ops the app dropped only because the line is ALREADY on the board mean the board is covered: no nudge (it would cost two more model calls for nothing).
  const coveredAlready = (a: { dropped: string[] }) => a.dropped.length > 0 && a.dropped.every((d) => /already on the board|already marked|already|near-duplicate/.test(d));
  for (let attempt = 0; attempt < 2 && soft() && !applied.board.length && !coveredAlready(applied) && (askedForBoard || claimsWriting(cur) || mathsFromStudent); attempt++) {
    const why = applied.dropped.length ? ` The app rejected these ops: ${applied.dropped.slice(0, 4).join("; ")}.` : "";
    const ask = askedForBoard ? " They asked for it on the board: write the most recent equation or step you and they reached, in full, as a step op." : "";
    const again: { turn: TurnOutput | null } | null = await callTurn([...messages, { role: "assistant", content: JSON.stringify(cur) }, { role: "user", content: `(Nothing new reached the board.${why}${ask} Check: a step they reached, the rule or reason, a figure or table that would help, a mark on a mistake. Anything you say you wrote must be written now. Send the same turn again with the board ops that belong, each with its cue, as ONLY the JSON object. If the line is already on the board, mark it instead and say so.)` }], result.tokens, deadline).catch(() => null);
    if (!again?.turn) break;
    const next = applyOps(again.turn.board, { board, problems, theirWords: [message] });
    if (next.board.length) { cur = again.turn; applied = next; break; }
    cur = again.turn; applied = next;
  }
  result.board = applied.board;
  // The sources go on the board once, right after the research, so the student can see where the session is anchored.
  if (input.researchFresh && input.research?.sources.length) {
    const note = makeBoardEntry({ text: `Sources I looked at — ${input.research.topic}\n${input.research.sources.slice(0, 4).map((x) => `• ${x.title}: ${x.url}`).join("\n")}`, kind: "note", owner: "otto" });
    if (!("error" in note)) result.board = [note.entry, ...result.board];
  }
  console.log(`[tutor] turn ${Date.now() - t0}ms tokens in=${result.tokens.in} out=${result.tokens.out} cached=${result.tokens.cachedIn} board=${applied.board.length}`); // (counts only: never the text)
  result.reply = cur.speech.join(" ");
  result.turn = { speech: cur.speech, ms: Date.now() - t0 };
  return result;
}

export type { TurnOutput };
export type { BoardEntry, TaskObjective, TaskProblem };
