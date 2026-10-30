// Otto holds the pen. The voice tutor writes the board itself through one tool, write_board, instead of a separate writer guessing what it meant:
// "I've put it on the board" is then true by construction, and the tool's answer tells the tutor exactly what is on the board. The same definition
// serves Gemini Live (functionDeclarations), OpenAI Realtime (session tools) and chat-completions models (the simulator). Pure data and text.
import type { BoardEntry } from "./types.ts";
import { boardLineNumbers } from "./boardLines.ts";

export const BOARD_TOOL_NAME = "write_board";
export const BOARD_TOOL_KINDS = ["given", "step", "result", "formula", "definition", "note", "focus"] as const;
export type BoardToolKind = (typeof BOARD_TOOL_KINDS)[number];
export interface BoardToolLine { kind?: string; latex?: string; replaces?: number | string }
export interface BoardToolResult { written: string[]; refused: { line: string; reason: string }[]; board: string }

const DESCRIPTION = "Write on the shared whiteboard the student is looking at. You hold the pen: nothing reaches the board unless you write it here. One call can write several lines. The reply lists what was written, anything refused (and why), and the whole board as it now stands with its line numbers.";
const LINES = "Board lines, in order.";
const KIND = "given: a problem or the data (exactly as posed, in full). step: a line of the student's own working, after they said it. result: a result the student reached. formula: a rule or formula the student arrived at or asked for. definition: a term's meaning. note: a short worked example on a DIFFERENT case, a correction or a reminder. focus: a short heading for a new topic.";
const LATEX = "The line: plain words with maths in $...$ LaTeX, e.g. Solve $\\frac{1}{2}(\\log\\frac{1}{4} + \\log k) = \\log(\\frac{1}{4}(k-3))$. One idea per line, no speech, no questions.";
const REPLACES = "Optional: the number of a line already on the board that this line corrects (a problem you wrote wrongly, a misheard value). The old line is removed.";

/** Gemini Live functionDeclarations entry (OpenAPI-style schema with upper-case types). */
export const BOARD_TOOL_GEMINI = {
  name: BOARD_TOOL_NAME,
  description: DESCRIPTION,
  parameters: {
    type: "OBJECT",
    properties: {
      lines: { type: "ARRAY", description: LINES, items: { type: "OBJECT", properties: { kind: { type: "STRING", enum: [...BOARD_TOOL_KINDS], description: KIND }, latex: { type: "STRING", description: LATEX }, replaces: { type: "INTEGER", description: REPLACES } }, required: ["kind", "latex"] } },
    },
    required: ["lines"],
  },
};

const JSON_PARAMS = {
  type: "object",
  properties: {
    lines: { type: "array", description: LINES, items: { type: "object", properties: { kind: { type: "string", enum: [...BOARD_TOOL_KINDS], description: KIND }, latex: { type: "string", description: LATEX }, replaces: { type: "integer", description: REPLACES } }, required: ["kind", "latex"] } },
  },
  required: ["lines"],
};

/** OpenAI Realtime session tool. */
export const BOARD_TOOL_REALTIME = { type: "function", name: BOARD_TOOL_NAME, description: DESCRIPTION, parameters: JSON_PARAMS };
/** Chat-completions tool (DeepSeek, Gemini's OpenAI endpoint): the simulator's stand-in for the voice model. */
export const BOARD_TOOL_CHAT = { type: "function", function: { name: BOARD_TOOL_NAME, description: DESCRIPTION, parameters: JSON_PARAMS } };

/** How the tutor uses the pen: goes into the voice instructions. */
export const BOARD_TOOL_RULES = `THE BOARD: YOU HOLD THE PEN (the ${BOARD_TOOL_NAME} tool)
- The student sees a whiteboard next to you. Nothing appears on it unless YOU write it with ${BOARD_TOOL_NAME}. Write as you talk, the way a tutor writes while explaining: call the tool in the same turn, before or while you say the sentence it belongs to.
- WRITE A PROBLEM THE MOMENT IT EXISTS: when you pose one (even a quick "try this one"), or the student reads or types one out, write it in full as a "given" line, exactly as stated, in that SAME reply, before you speak it. A problem you only say out loud does not exist for the student. If they correct you ("no, the half multiplies both logs"), rewrite it with "replaces" set to the wrong line's number, then say so in a few words.
- A SPOKEN PROBLEM CAN BE AMBIGUOUS (what a fraction, a factor or a power applies to): write your reading, then ask in a few words whether that is what they meant ("is the half multiplying both logs?"). Never start solving an unconfirmed reading.
- THE STUDENT'S WORKING: after they say a step, write it as a "step" (their content, cleaned into notation). Write only what they said; never the step after it.
- RULES AND FORMULAS ARE ARRIVED AT, NOT HANDED OVER: write a "formula" or "definition" only once the student has stated it or explicitly asked for it ("what's the formula?", "I don't know it"). A rule you only hint at stays off the board.
- NEVER WRITE THE ANSWER to the question you are asking, and never the next step of the student's own problem. When you explain after two failed tries, write a worked example on a DIFFERENT case as a "note".
- "Write it out", "put it on the board", "can you write the whole thing?" mean: write what exists so far (the problem, the steps they have done). That is never giving the answer; do it at once.
- The tool's reply is the truth about the board: it lists the board with line numbers, and anything it refused. Point at lines by number ("look at line 4"). Only say something is on the board after the reply shows it written; if a line was refused, do not claim it, and follow the reason given.
- WHEN THEIR WORKING IS WRONG, never write the correct version (not even as "the standard result" to compare with): leave their line, point at it by number and ask about the exact slip.
- SAY LESS, WRITE MORE: speak one to three short sentences (about 40 words at most); the problem, the data and the working live on the board, so do not read them out.
- Never talk to the student about the board's mechanics (what was refused, duplicates, the tool). If a write is refused, follow the reason silently and carry on teaching.
- Keep the board clean: one idea per line, no questions or speech on it, no duplicates. A question with parts is one "given" line per part.`;

/** The board as the tutor sees it in a tool reply: the same line numbers the student sees in the margin (boardLineNumbers). Pure. */
export function boardListing(board: BoardEntry[], max = 30): string {
  const nums = boardLineNumbers(board);
  const rows = board.filter((e) => typeof e.text === "string" && e.text.trim()).slice(-max);
  return rows.length ? rows.map((e) => `${nums.has(e.id) ? `${nums.get(e.id)}.` : "-"} [${e.kind || "note"}] ${String(e.text).replace(/\s+/g, " ").slice(0, 220)}`).join("\n") : "(the board is empty)";
}
