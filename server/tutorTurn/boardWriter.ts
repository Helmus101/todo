// THE BOARD WRITER for the live voice. The voice (Gemini Live) is the tutor: it talks, and never writes. After every spoken exchange this
// one call decides what goes on the paper: the problem, the student's own CORRECT steps (as Otto's own clean lines, never their words),
// a one-line takeaway when the tutor explained an idea, and figures. Same op shapes and builders as the engine (apply.ts), so graphs,
// geometry, tables, timelines and cycles all render the same way.
import type { BoardEntry } from "../../shared/types.ts";
import { extractJsonObject, normalizeTurn, salvageTurn } from "../../shared/tutorTurn.ts";
import { boardSurfaceBlock } from "../boardEvents.ts";
import { createTutorChat, usageOf } from "../claude.ts";
import { applyOps } from "./apply.ts";
import { DRAW_REFERENCE, TURN_PROMPT } from "./prompt.ts";

const OPS = TURN_PROMPT.slice(TURN_PROMPT.indexOf("BOARD OPS"), TURN_PROMPT.indexOf("RETURN ONLY"));

export const BOARD_WRITER_PROMPT = `You keep the paper whiteboard for a spoken tutoring session. You never speak. You receive the latest spoken exchange (Student and Tutor lines) and what is already on the board, and you return the board ops to add.

WRITE ONLY:
1. THE PROBLEM, once, when the student states it: a "topic" op for a new problem or topic, then a "given" step with the full statement, cleanly typeset (maths in $…$). Never their raw words, never a "how would I solve this" lead-in.
2. THE STUDENT'S OWN STEPS and results, as they say them, ONLY when they are right: first recompute each one yourself. Write it as your own clean typeset line (kind "result" or "formula"), with no "why". A step that is wrong or unclear: write nothing for it, and never write the correction.
3. WHAT THE TUTOR EXPLAINED OR DEMONSTRATED: whenever the tutor gives a definition, a rule, a formula, an identity or a worked example, WRITE IT, as clean lines (kind "definition", "formula" or "result"; typeset maths in $…$; add a short "why" only when the reason is not obvious). The student should be able to look back at it: if the tutor said "since 2 to the power of 3 is 8, the log base 2 of 8 is 3", the board gets the definition and that example. Write the explanation and the example the tutor used, NOT the question the tutor then asks. When in doubt about an explanation, write it.
4. FIGURES that help them see it (draw ops: a graph, geometry, flow / cycle / timeline, table, number line, source...), whenever a picture would teach faster. Draw on an existing graph with "extend" instead of redrawing it.

HOW MUCH: the board is the whole lesson on paper, so an exchange that teaches or confirms something usually adds one to three lines: the rule or definition, the worked example, the result the student reached (when the tutor confirms it is right), the final answer once THEY reached it. An empty list is right only for greetings, small talk, a question that adds nothing new, or an answer that was wrong.

NEVER WRITE: the tutor's questions, hints that point at the student's next step, a result the student has not reached, praise, chit-chat, or the tutor's sentences. Maths in $…$, lines short, one idea per line. Never repeat a line that is already on the board. If nothing qualifies, return {"board":[]}.


EXAMPLE
Exchange: "Student: I don't get logarithms" / "Tutor: To start from scratch, think of a logarithm as the opposite of an exponent. For example, since 2 to the power of 3 is 8, the logarithm base 2 of 8 is 3. What do you think the logarithm base 3 of 9 would be?"
Return: {"board":[{"op":"topic","cue":0,"text":"Logarithms"},{"op":"step","cue":0,"text":"A logarithm is the opposite of an exponent: $\\log_b x = y \\iff b^y = x$","kind":"definition"},{"op":"step","cue":0,"text":"$2^3 = 8 \\implies \\log_2 8 = 3$","kind":"formula"}]}
(The question about $\\log_3 9$ is NOT written: the tutor asks it out loud.)

${OPS}
Return ONLY JSON: {"board":[…ops…]}. Every op carries "cue":0. Inside strings write every LaTeX backslash TWICE.`;

/** The tutor said something worth keeping (a definition, a rule, a worked example, a formula): numbers or maths with an explaining word. */
export function tutorExplained(exchange: string): boolean {
  const tutor = exchange.split("\n").filter((l) => /^Tutor:/i.test(l)).map((l) => l.replace(/^Tutor:\s*/i, "")).join(" ");
  if (tutor.split(/\s+/).length < 14) return false;
  return /\b(?:for example|for instance|means|is the (?:opposite|inverse|same)|opposite of|equals?|is called|defined as|the rule|formula|because|so that|therefore|works like|think of)\b/i.test(tutor) && (/\d|\$|=|\bsquared|\bpower\b|\bbase\b|\bderivative\b|\bintegral\b/i.test(tutor) || tutor.split(/\s+/).length > 30);
}

export async function writeBoard(input: { exchange: string; board: BoardEntry[]; subject?: string; history?: string }, tokens: { in: number; out: number; cachedIn: number }): Promise<{ board: BoardEntry[]; dropped: string[] }> {
  const canDraw = !input.subject || /math|physic|chem|bio|econ|scien|geom|stat|calc|algebra|trig|histor|geograph/i.test(input.subject) || input.board.some((b) => ["graph", "svg", "diagram"].includes(String(b.kind)));
  const system = BOARD_WRITER_PROMPT + (canDraw ? DRAW_REFERENCE : "") + `\n\nTHE BOARD (margin numbers #n are what you point at)${boardSurfaceBlock(input.board, []) || ": empty."}`;
  const user = `${input.subject ? `Subject: ${input.subject}\n` : ""}${input.history ? `EARLIER IN THIS SESSION (context only: it tells you what a short answer like "two, right?" refers to; do NOT rewrite what is already on the board):\n${input.history.slice(-2500)}\n\n` : ""}LATEST EXCHANGE:\n${input.exchange.slice(0, 4000)}`;
  const studentWords = input.exchange.split("\n").filter((l) => /^Student:/i.test(l)).map((l) => l.replace(/^Student:\s*/i, ""));
  const once = async (extra?: string) => {
    const messages: any[] = [{ role: "system", content: system }, { role: "user", content: user }];
    if (extra) messages.push({ role: "user", content: extra });
    const res = await createTutorChat({ max_tokens: 2500, temperature: 0.1, response_format: { type: "json_object" }, messages }, true);
    const u = usageOf(res); tokens.in += u.in; tokens.out += u.out; tokens.cachedIn += u.cachedIn;
    const raw = String(res?.choices?.[0]?.message?.content || "");
    const parsed: any = extractJsonObject(raw) ?? salvageTurn(raw);
    const turn = normalizeTurn({ speech: ["."], board: Array.isArray(parsed?.board) ? parsed.board : [] });
    if (!turn || !turn.board.length) return { board: [] as BoardEntry[], dropped: [] as string[] };
    const applied = applyOps(turn.board.map((o) => ({ ...o, cue: 0 })), { board: input.board, problems: [], theirWords: studentWords });
    return { board: applied.board, dropped: applied.dropped };
  };
  let out = await once();
  // The board has to match the explanation: when the tutor explained something and nothing was written (the model was cautious, or the app
  // rejected the ops), ask once more, saying exactly that.
  if (!out.board.length && tutorExplained(input.exchange)) {
    const why = out.dropped.length ? ` The app rejected these ops: ${out.dropped.slice(0, 3).join("; ")}.` : "";
    const second = await once(`(You wrote nothing, but the tutor explained something worth keeping.${why} Write the definition or rule and the worked example the tutor gave as board lines now, never the question it asked. Return the same JSON shape.)`);
    if (second.board.length) out = second;
    else console.warn(`[live] board writer wrote nothing for an explanation (${(second.dropped.length ? second.dropped : out.dropped).slice(0, 2).join("; ") || "no ops"})`);
  }
  return out;
}
