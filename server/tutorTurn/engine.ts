// ONE TUTOR TURN: the prompt (who Otto is + the board as it stands) and the conversation go to the model once; it answers
// {speech, board}; the board ops become board entries (apply.ts). No checks, no repair calls, no fixed replies: every word
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

const MAX_HISTORY = 14;
const TURN_MAX_TOKENS = 4000;
const TURN_TIMEOUT_MS = 60_000;

async function callTurn(messages: any[], tokens: TutorTurnResult["tokens"]): Promise<{ turn: TurnOutput | null; raw: string }> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  const ask = (json: boolean) => retryRequest(() => createTutorChat({ max_tokens: TURN_MAX_TOKENS, temperature: 0.5, messages, ...(json ? { response_format: { type: "json_object" } } : {}) }, true, { deadline }), 2, 400);
  let res: any;
  // JSON mode first; a provider that rejects the parameter gets the same request without it (the prompt asks for JSON anyway).
  try { res = await ask(true); } catch (e: any) { if (Number(e?.status) === 400) res = await ask(false); else throw e; }
  const u = usageOf(res); tokens.in += u.in; tokens.out += u.out; tokens.cachedIn += u.cachedIn;
  const raw = String(res?.choices?.[0]?.message?.content || "");
  // Prose instead of JSON still beats an error: it is spoken as it is.
  return { turn: normalizeTurn(extractJsonObject(raw)) ?? normalizeTurn(salvageTurn(raw, { prose: true })), raw };
}

const POINTS_AT_BOARD = /\b(?:here(?:'s| is| are)|we have|we got|this|these|that|the following|look at|see)\b[^.?!]{0,40}\b(?:equation|expression|formula|identity|figure|graph|diagram|curve|triangle|step|line|inequality|function)\b/i;

export async function runTutorTurn(input: TutorTurnInput): Promise<TutorTurnResult & { turn?: { speech: string[]; ms: number } }> {
  const t0 = Date.now();
  const { message, history, board, problems, context } = input;
  const result: TutorTurnResult & { turn?: { speech: string[]; ms: number } } = { reply: "", board: [], problems: [], tokens: { in: 0, out: 0, cachedIn: 0 }, guardrailTripped: false };

  const spokenRepair: SpokenRepair | null = input.spoken ? repairSpokenMath(message, spokenContextFrom([context.subject || "", ...board.map((b) => b.text || "")])) : null;
  const canDraw = !context.subject || /math|physic|chem|bio|econ|scien|geom|stat|calc|algebra|trig/i.test(context.subject) || board.some((b) => ["graph", "svg", "diagram"].includes(String(b.kind)));
  const system = TURN_PROMPT
    + (canDraw ? DRAW_REFERENCE : "")
    + (input.voiceMode ? VOICE_NOTE : "")
    + backgroundBlock(context)
    + `\n\nToday is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`
    + `\n\nTHE BOARD (margin numbers #n are what you point at)${boardSurfaceBlock(board, problems) || ": empty."}`
    + (input.spoken && spokenRepair ? voiceInputBlock(message, input.spoken.alternatives, spokenRepair) : "")
    + `\n\nReply in English unless the student writes in another language. Return ONLY the JSON object.`;
  const messages: any[] = [
    { role: "system", content: system },
    ...history.slice(-MAX_HISTORY).filter((h) => h.text?.trim()).map((h) => ({ role: h.role, content: h.text.slice(0, 4000) })),
    { role: "user", content: message },
  ];

  let turn: TurnOutput | null = null, raw = "";
  try {
    ({ turn, raw } = await callTurn(messages, result.tokens));
    if (!turn) ({ turn } = await callTurn([...messages, { role: "assistant", content: raw.slice(0, 2000) }, { role: "user", content: "(That wasn't the JSON object. Send the same turn again as ONLY the JSON object described above.)" }], result.tokens));
  } catch (e: any) {
    result.errorKind = classifyProviderError(e);
    console.error(`[tutor] model request failed: ${result.errorKind}${e?.status ? ` ${e.status}` : ""}`); // (kind and status only: provider error bodies can echo prompt text)
    result.error = true;
    return result;
  }
  if (!turn) { console.error("[tutor] no usable turn"); result.error = true; return result; }

  // Nothing was written or drawn although the reply points at something, or the student gave maths: ask once for the board ops.
  if (!turn.board.length && (POINTS_AT_BOARD.test(turn.speech.join(" ")) || (/[\d=]/.test(message) && message.length > 2))) {
    const again = await callTurn([...messages, { role: "assistant", content: JSON.stringify(turn) }, { role: "user", content: "(You wrote nothing on the board. Check: a step they reached, the rule or reason, a figure or table that would help, a mark on a mistake. Send the same turn again with the board ops that belong (and anything you refer to must be written or drawn), each with its cue. If truly nothing belongs, return the same turn.)" }], result.tokens).catch(() => null);
    if (again?.turn?.board.length) turn = again.turn;
  }
  const applied = applyOps(turn.board, { board, problems, theirWords: [message] });
  result.board = applied.board;
  result.reply = turn.speech.join(" ");
  result.turn = { speech: turn.speech, ms: Date.now() - t0 };
  return result;
}

export type { TurnOutput };
export type { BoardEntry, TaskObjective, TaskProblem };
