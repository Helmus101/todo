// THE TUTOR — one turn of a live tutoring session (the /tutor stage).
//
// Deliberately simple: one clear prompt, the conversation, the board, and a short background digest — then
// the model talks and writes on the board through a handful of tools. Code only steps in where something must
// never go wrong, and each check is cheap and deterministic:
//   · an answer the student is meant to find never appears in a reply or on the board (problems, open gaps)
//   · every equation written to the board actually typesets (KaTeX, server/latexCheck.ts via makeBoardEntry)
//   · arithmetic the reply asserts is actually right (server/arithmetic.ts)
//   · a step the student gives is checked against the open gap by code, not judged by the model (mathEquiv.ts)
//   · spoken input is repaired against the board, and the board never repeats a mishearing (spokenMath.ts)
// Everything else — how Socratic to be, how much help, which board tool — is the prompt's job.
import { randomUUID } from "node:crypto";
import type { BoardEntry, Profile, TaskObjective, TaskProblem } from "../shared/types.ts";
import { buildTrigScene } from "../shared/trigScene.ts";
import { sanitizeSvg, svgText } from "../shared/svgSafe.ts";
import { repairSpokenMath, spokenContextFrom, type SpokenRepair } from "../shared/spokenMath.ts";
import { equationsAhead, asksForFormula } from "../shared/equationsAhead.ts";
import { findArithmeticClaims } from "./arithmetic.ts";
import { boardSurfaceBlock } from "./boardEvents.ts";
import { replyStatesValue, socraticFallback, voiceInputBlock, boardRepeatsMishearing, asksToMoveOn, asksForProblem, looksLikeGivensOrScenario, inventedNumbers, confirmsUnchecked, wrapsUpUnasked, blamesWidget, asksToWrite } from "./tutorAdapt.ts";
import { latexToPlainText } from "../shared/mathText.ts";
import { toExprSource } from "../shared/mathEquiv.ts";
import { compileExpr } from "../shared/mathExpr.ts";
import {
  createTutorChat, retryRequest, usageOf, parseToolArgs, stripLeakedToolCallSyntax, OUT,
  CREATE_PROBLEM_TOOL, GEOMETRY_ON_BOARD_TOOL, GRAPH_ON_BOARD_TOOL, SVG_ON_BOARD_TOOL, FLOW_ON_BOARD_TOOL,
  WIDGET_ON_BOARD_TOOL, TRIG_SCENE_ON_BOARD_TOOL, CREATE_INTERACTIVE_TOOL, ANNOTATE_BOARD_TOOL, SET_OBJECTIVES_TOOL,
  makeProblem, makeBoardEntry, makeGeometryEntry, makeGraphEntry, makeSvgEntry, makeFlowEntry, makeWidgetEntry,
  makeInteractiveEntry, makeObjectives, leaksAnyProblemAnswer, isDuplicateBoardEntry, isDuplicateDiagram, isDuplicateProblem,
  resolveBoardTarget, stepVerdictLine, openerMemoryBlock, studentNameLine, personalContextLine, recentJournalLine,
  sessionRecapLine, milestoneLine, errorLogLine, nowBlock, type TutorOpenerMemory,
} from "./claude.ts";
import { repairLatex, latexifyBoardLine } from "./tutorAdapt.ts";

// ── The prompt ────────────────────────────────────────────────────────────────────────────────────────
export const TUTOR_PROMPT = `You are Otto, a tutor working one-on-one with a student. You talk with them like a real person sitting next to them, with a shared sheet of paper between you (the BOARD).

YOUR ONE JOB: make them an independent thinker. They should leave able to solve the next problem without you. So THEY do the thinking: you ask, they answer; you point, they find; you check, they fix.

HOW YOU TALK
- Hear them first. What did they actually say, and what's underneath (lost, curious, rushing, an idea forming, a side question)? Answer what they asked before you steer. If they correct you or say it isn't working, they're right until proven otherwise: try a different approach.
- Like a person, not a worksheet. React to what they actually just said first ("ah, nice", "hm, close", "wait, where did the 3 go?"), then ONE question or ONE small nudge. Usually 1-3 short sentences. No lists, no headings, no lectures, no filler praise.
- Answer in the language they write in. Use their name now and then if you know it.
- Adapt to them. Fluent? Bigger steps, harder questions. Stuck or frustrated? Smaller steps, a figure, a warmer tone ("this one is fiddly, most people trip here"). Never repeat a question that didn't land: ask it differently.
- Every reply ends with one clear thing for them to do or answer.

SOCRATIC, FOR REAL
- Never give the answer, the next step's result, or the option letter. Not even slipped in ("so it's 12, right?"). If they ask for it, give them a smaller piece instead.
- Climb only as far as needed, one rung at a time: a question that makes them notice something → point at something on the board → hint the method (never the result) → a worked example with DIFFERENT numbers, last line left for them → only then state the general rule. Drop back down as soon as they're moving again.
- Never derive an equation for them and never tell them which formula or equation to use. Ask first: "what do you know that links power and speed?", "which relationship involves the angle?". An equation goes on the board only once THEY have said it (then write it up as theirs). If they ask you outright for a formula or a definition, answer it.
- The first move is theirs: the key idea of a problem (which identity, the substitution, how to set up the equation, how to split the angle) is never in your question or on the board. Ask what they'd try first.
- Only their numbers: every figure you say is one they or the problem gave. Never compute ahead ("take the square root of 390.4"), never state something and then quiz them on it.
- Concepts are different from answers: if they ask "what is X?" or "why does this work?", explain it briefly and clearly (an example or a picture beats a definition), then check understanding with a question that makes them use it.
- Ask real thinking questions: "what do you know?", "what are we looking for?", "why does that work?", "how could you check it?", "does it always hold?", "what would happen if…?", "how sure are you?".
- Before a multi-step problem, ask for their plan first. When they're done, have them check their answer makes sense, name the method they used, and ask if they see another way (offer one if they don't, e.g. a graph instead of algebra, a tree instead of a formula). Then ask which they'd use in an exam and why.
- Don't be rigid. A correct step is done: acknowledge it in a few words and move on, never make them redo or rewrite it. If they're stuck twice on the same thing, give a bigger piece.

BE RIGHT
- Before you ask or react, work the problem out yourself: the answer, the units, the quickest route. That's how you tell a good move from a slip.
- Check every step they make yourself, from the givens, before reacting. "Spot on" is only for a value you recomputed and that matches THEIR number. Never confirm a wrong step, never call a right one wrong. If something's off, don't say "wrong": ask the question that lets them spot it.
- A line starting "VERIFIED BY CODE" is the truth about their step. Trust it over your own reading.
- If you're unsure what they meant, ask, offering your best reading.
- Never invent facts or steps, and never blame the app: if an exercise's key disagrees with an answer you believe is right, recompute and say plainly that the key was wrong.

THE BOARD (shared digital paper)
- The board holds the maths and structure; your message holds the conversation. Don't repeat one in the other.
- Put things there they'd otherwise have to remember: the givens, a figure, the equation in play, their own steps (owner "student"), a definition, an outline. Maths always typeset in LaTeX between $…$ (e.g. $\\frac{h}{\\tan 25^\\circ}$).
- Leave the next step as a GAP for them: WRITE_TO_BOARD kind "gap" with the line ending "= ?" and expectedAnswer set. Never write a step they haven't reached or the final answer.
- When they solve or state something, write it up as their line. Point at a line with ANNOTATE_BOARD instead of re-explaining it.
- Tools: CREATE_PROBLEM (one practice problem with an answer box, one at a time), GEOMETRY_ON_BOARD / TRIG_SCENE_ON_BOARD (exact figures), GRAPH_ON_BOARD (functions), SVG_ON_BOARD (any other drawing), FLOW_ON_BOARD (processes, causes, essay plans), WIDGET_ON_BOARD (match/sort/order activities), SET_OBJECTIVES (the session's goals, once you know what you're working on), CLEAR_BOARD (new topic).
- The board never answers your own question: whatever you ask them to work out must not already be written there (leave it as "?").
- Lists, tables, cheat sheets and anything longer than a sentence or two go on the board; the message just points at it.
- Never put their sentences on the board (clean maths and structure only), and never erase: correct by adding the fixed version next to it.
- Exercises: only when they ask for one (offer, then wait for a yes), and only for a single short checkable answer — state the precision (decimal places) and unit. Open questions (explain, why, compare) stay in the conversation.
- Use the board when it helps thinking, not every turn for its own sake.

ANY SUBJECT
- Maths/sciences: givens, figure, equation, gaps. History/economics: causes → effects, evidence, a timeline or argument outline. Essays/literature: thesis, structure, quotes; ask them to argue, never write it for them. Languages: vocabulary, a sentence to transform, their own attempt.

SAFE AND KIND
- Never harsh, never shaming; age-appropriate always. Off-topic → one friendly line, then back to the work. Don't offer to wrap up ("ready for another?", "call it a win?") unless they ask.
- First turn with nothing said yet: say hello and ask what they're working on — don't quiz.

CONTEXT
- What's happening in THIS conversation comes first. The background below (journal, past sessions, deadlines, profile) is there if it genuinely helps (a link to what they learned before, an upcoming test): use it lightly, never recite it.`;

const VOICE_BLOCK = `\n\nVOICE MODE: your reply is read aloud. Write it as speech: no symbols, no LaTeX, no markdown in the reply. Every equation goes on the board, and you refer to it ("look at the second line").`;

// ── Tools (the board) ─────────────────────────────────────────────────────────────────────────────────
const WRITE_TO_BOARD = {
  name: "WRITE_TO_BOARD",
  description: "Write one short entry on the board: keywords and structure, not prose (≤ 25 words). Maths in LaTeX between $…$. Never use it to set an exercise: a problem for them to solve always goes through CREATE_PROBLEM (it gets an answer box).",
  input_schema: { type: "object", properties: {
    text: { type: "string", description: "the entry. Several short lines are fine for a worked sequence (one move per line)." },
    kind: { type: "string", enum: ["given", "formula", "definition", "result", "summary", "insight", "instruction", "focus", "outline", "gap"], description: "given = the problem's data; result = something they derived; summary = their reasoning so far; insight = their aha; gap = a line for THEM to finish (ends in '= ?'); outline = headed bullets." },
    expectedAnswer: { type: "string", description: "REQUIRED for kind 'gap': what they should write (e.g. 'h/tan(25°)', '0.25', 'friction'). Never revealed." },
    gapAction: { type: "string", description: "REQUIRED for kind 'gap': 2-6 words naming the move ('express b with tan 25°'). Never the value." },
    owner: { type: "string", enum: ["otto", "student"], description: "'student' when you're writing up THEIR work." },
    outline: { type: "array", description: "kind 'outline' only: [{heading, bullets[]}]", items: { type: "object", properties: { heading: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["heading", "bullets"] } },
  }, required: ["text"] },
};
const CLEAR_BOARD = {
  name: "CLEAR_BOARD",
  description: "Start a clean board for a new topic or problem. Keeps the session focus line unless keepFocus is false.",
  input_schema: { type: "object", properties: { keepFocus: { type: "boolean" } } },
};
const PROBLEM = { ...CREATE_PROBLEM_TOOL, description: "Put ONE practice problem on the board with an answer box (only when there is exactly one short, checkable answer). Only one unanswered problem at a time. Give `check` (an expression computing the answer) for any numeric answer." };

export function tutorTools(canvasMode: boolean) {
  return [WRITE_TO_BOARD, PROBLEM, ANNOTATE_BOARD_TOOL, GEOMETRY_ON_BOARD_TOOL, TRIG_SCENE_ON_BOARD_TOOL, GRAPH_ON_BOARD_TOOL, SVG_ON_BOARD_TOOL, FLOW_ON_BOARD_TOOL, WIDGET_ON_BOARD_TOOL, SET_OBJECTIVES_TOOL, CLEAR_BOARD, ...(canvasMode ? [CREATE_INTERACTIVE_TOOL] : [])];
}

// ── Context ───────────────────────────────────────────────────────────────────────────────────────────
export interface TutorContext {
  profile?: Profile;
  subject?: string;
  journal?: { date: string; text: string }[];
  /** Upcoming homework/tests line(s), already formatted (schoolRecordLine). */
  schoolRecord?: string;
  /** The browser's record of recent sessions (sessionMemoryForPrompt). */
  memory?: TutorOpenerMemory[];
}

/** The background digest: everything the rest of the app knows, compact, explicitly secondary to the chat. */
export function backgroundBlock(c: TutorContext): string {
  const p = c.profile;
  const parts = [
    studentNameLine(p?.name),
    personalContextLine(p),
    milestoneLine(p, c.subject),
    errorLogLine(p, c.subject),
    recentJournalLine(c.journal, c.subject),
    sessionRecapLine(p?.sessions, c.subject),
    openerMemoryBlock(c.memory),
    c.schoolRecord || "",
  ].map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return "";
  return `\n\nBACKGROUND (secondary: use only when it helps with what's happening now)\n${parts.join("\n")}`;
}

function objectivesBlock(objectives: TaskObjective[]): string {
  if (!objectives.length) return "";
  return `\n\nSESSION OBJECTIVES:\n${objectives.map((o) => `- [${o.done ? "x" : " "}] ${o.label}`).join("\n")}`;
}

// ── One turn ──────────────────────────────────────────────────────────────────────────────────────────
export interface TutorTurnInput {
  history: { role: "user" | "assistant"; text: string }[];
  message: string;
  board: BoardEntry[];
  /** Problems on the board, WITH their answer keys (the route rehydrates them server-side). */
  problems: TaskProblem[];
  objectives: TaskObjective[];
  context: TutorContext;
  voiceMode?: boolean;
  canvasMode?: boolean;
  spoken?: { alternatives: string[] };
  stepVerdict?: { gap: string; given: string; verdict: "correct" | "incorrect" };
  lang: "fr" | "en";
}

export interface TutorTurnResult {
  reply: string;
  board: BoardEntry[];
  boardCleared?: boolean;
  problems: TaskProblem[];
  objectives?: TaskObjective[];
  tokens: { in: number; out: number; cachedIn: number };
  /** The model failed outright (no reply at all). */
  error?: boolean;
  /** A reply had to be replaced because it gave the answer away. */
  guardrailTripped: boolean;
}

const MAX_TOOL_ROUNDS = 5;
const MAX_HISTORY = 30;

/** The answer keys a reply must not state: open gaps (board + this turn) and unsolved problems. A value the
 *  student already said themselves is theirs, not a leak. Exported for tests. */
export function leakedValue(reply: string, message: string, board: BoardEntry[], problems: TaskProblem[]): string | null {
  for (const g of board) {
    if (g.kind !== "gap" || !g.expectedAnswer || g.status === "correct") continue;
    if (replyStatesValue(reply, g.expectedAnswer) && !replyStatesValue(message, g.expectedAnswer)) return g.expectedAnswer;
  }
  const open = problems.filter((p) => !p.solved);
  if (open.length && leaksAnyProblemAnswer(reply, open) && !leaksAnyProblemAnswer(message, open)) return "the problem's answer";
  return null;
}

/** The student asked to be given an exercise ("give me a problem", "test me", "un exercice"). Exported for tests. */
export function wantsExercise(message: string): boolean {
  return asksForProblem(message) || /\b(?:one|a|the)\s+(?:last|final|other)\s+(?:problem|exercise|question|one)\b|\bcan you (?:do|make|give|create)\b[^.?!]{0,20}\b(?:problem|exercise|question)\b|\b(?:quiz|test) me\b|\binterroge[- ]moi\b|\b(?:un|des|un autre|nouvel?)\s+(?:exo|exercice|probl[èe]me)s?\b|\bpractice (?:problem|question)s?\b/i.test(String(message || ""));
}

/** A board line that sets up a problem nobody gave: a scenario/givens line (2+ quantities with units) carrying a
 *  number that appears nowhere in what the student said or in a problem already posted. That's Otto inventing an
 *  exercise as plain board text — it belongs in CREATE_PROBLEM, with an answer box. Exported for tests. */
export function inventsProblemOnBoard(text: string, said: string[]): boolean {
  if (!looksLikeGivensOrScenario(text)) return false;
  const nums = (String(text).replace(/\\[a-zA-Z]+/g, " ").match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", "."));
  const heard = new Set((said.join(" ").match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", ".")));
  return nums.some((n) => !heard.has(n));
}

/** The reply asks them to recheck something that is RIGHT: the app already marked their exercise answer right, or
 *  the number they just gave IS the value of the expression the reply tells them to redo ("235,200" vs "multiply
 *  1200×9.8×20"; "24350" vs "800×9.8×sin(15°)×12"). Returns the correction note, or null. Exported for tests. */
export function doubtsRightAnswer(reply: string, message: string): string | null {
  const RECHECK = /\b(?:check (?:that|this|it|your|the)|(?:try|run|re-?run|work|do) (?:it |that |this )?(?:out )?again|re-?check|re-?run|let'?s (?:check|re-?run|redo)|double[- ]check|not quite|was from the previous|look again|try \d)/i;
  if (!RECHECK.test(reply)) return null;
  if (/\[(?:Exercise|Exercice)\][^\n]*(?:marked right|checked right|juste|vérifié juste)/i.test(message)) return "the app already checked their answer and it is RIGHT — don't ask them to redo it; acknowledge it and move on";
  const num = (x: string) => Number(x.replace(/(\d)[\s,](?=\d{3}(?!\d))/g, "$1").replace(",", "."));
  const theirs = (message.match(/\d[\d\s,]*(?:\.\d+)?/g) || []).map((x) => num(x.trim())).filter((n) => Number.isFinite(n) && n >= 10);
  if (!theirs.length) return null;
  const plain = latexToPlainText(reply.replace(/\$/g, " "));
  for (const m of plain.matchAll(/\d[\d.,]*\s*[×x*·]\s*[\d\s.,×x*·()°a-z]*\d[)°]*/gi)) {
    const src = toExprSource(m[0].replace(/(\d),(\d{3})/g, "$1$2"));
    const f = compileExpr(src, []);
    if ("error" in f) continue;
    const v = f.fn({});
    const hit = Number.isFinite(v) && theirs.find((n) => Math.abs(n - v) <= 0.005 * Math.max(1, Math.abs(v)));
    if (hit) return `their ${hit} IS ${m[0].trim()} (= ${Math.round(v * 100) / 100}) — they were RIGHT; confirm it instead of asking them to redo it`;
  }
  return null;
}

/** A wrong arithmetic claim in the reply ("12 × 3 = 38"), as a correction note for the model, or null. */
export function wrongArithmetic(reply: string, message = ""): string | null {
  // A wrong claim the STUDENT made, quoted back to them, is the point of the reply — not Otto's own slip.
  const said = message.replace(/\s+/g, "");
  const bad = findArithmeticClaims(reply).filter((c) => c.mismatch && !said.includes(c.raw.replace(/\s+/g, "")));
  if (!bad.length) return null;
  return bad.map((c) => `"${c.raw}" is false (the left side is ${c.left})`).join("; ");
}

function cleanReply(text: string, voice: boolean): string {
  let t = stripLeakedToolCallSyntax(String(text || "")).replace(/<plan>[\s\S]*?<\/plan>/gi, "").trim();
  t = t.replace(/^\s*(otto|tutor)\s*:\s*/i, "").replace(/\*\*(.+?)\*\*/g, "$1");
  // Read aloud: maths becomes readable text ("1000 × 9.8 × sin(10°) × 15", "1/2 mv^2"). It used to just delete every
  // \command, so \times and \sin vanished and "\frac12" read as "12" — "multiply 10009.8(10°)15" (reported live).
  if (voice) t = t.replace(/\$([^$]+)\$/g, (_, x: string) => latexToPlainText(x)).replace(/\\[a-zA-Z]+(?:\s*\{[^{}]*\})*/g, (m) => latexToPlainText(m));
  return t.trim();
}

export async function runTutorTurn(input: TutorTurnInput): Promise<TutorTurnResult> {
  const { message, history, board, problems, objectives, context, lang } = input;
  const fr = lang === "fr";
  const result: TutorTurnResult = { reply: "", board: [], problems: [], tokens: { in: 0, out: 0, cachedIn: 0 }, guardrailTripped: false };

  const spokenRepair: SpokenRepair | null = input.spoken
    ? repairSpokenMath(message, spokenContextFrom([context.subject || "", ...board.map((b) => b.text || ""), ...problems.map((p) => p.question || "")]))
    : null;

  const system = TUTOR_PROMPT
    + (input.voiceMode ? VOICE_BLOCK : "")
    + nowBlock()
    + backgroundBlock(context)
    + objectivesBlock(objectives)
    + (boardSurfaceBlock(board, problems) || "\n\nTHE BOARD IS EMPTY.")
    + stepVerdictLine(input.stepVerdict)
    + (input.spoken && spokenRepair ? voiceInputBlock(message, input.spoken.alternatives, spokenRepair) : "");

  const messages: any[] = [
    { role: "system", content: system },
    ...history.slice(-MAX_HISTORY).filter((h) => h.text?.trim()).map((h) => ({ role: h.role, content: h.text.slice(0, 4000) })),
    { role: "user", content: message },
  ];
  const tools = tutorTools(!!input.canvasMode).map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));

  const said = [...history.filter((h) => h.role === "user").map((h) => h.text), message, ...(spokenRepair ? [spokenRepair.interpreted, ...(input.spoken?.alternatives || [])] : []), ...problems.map((p) => p.question || ""), ...board.filter((b) => b.kind === "given" || b.owner === "student").map((b) => b.text)];
  const wantsProblem = wantsExercise(message);
  const allBoard = () => [...(result.boardCleared ? [] : board), ...result.board];
  const allProblems = () => [...problems, ...result.problems];
  let corrected = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const lastRound = round === MAX_TOOL_ROUNDS;
    let res: any;
    try {
      res = await retryRequest(() => createTutorChat({
        max_tokens: OUT.chat, temperature: 0.7,
        messages: lastRound ? [...messages, { role: "user", content: "Reply to the student now in plain words, no more tools." }] : messages,
        ...(lastRound ? {} : { tools }),
      }, true), 2, 400);
    } catch (e: any) {
      console.error(`[tutor] model request failed: ${e?.message || e}`);
      result.error = true;
      return result;
    }
    const u = usageOf(res); result.tokens.in += u.in; result.tokens.out += u.out; result.tokens.cachedIn += u.cachedIn;
    const msg = res?.choices?.[0]?.message || {};
    const toolCalls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const text = String(msg.content || "");

    if (!toolCalls.length || lastRound) {
      const reply = cleanReply(text, !!input.voiceMode);
      if (!reply) {
        if (!corrected && !lastRound) { corrected = true; messages.push({ role: "user", content: "(Now reply to the student — a short message ending with one question.)" }); continue; }
        result.error = true;
        return result;
      }
      // The hard checks, all at once: every problem found goes back in ONE correction round.
      const leaked = leakedValue(reply, message, allBoard(), allProblems());
      const issues: string[] = [];
      if (leaked) issues.push(`it gives away ${leaked === "the problem's answer" ? "the answer to the open problem" : `the value of the open gap (${leaked})`} — they must find it; keep the idea, drop the value, end with one question that gets them there`);
      if (wantsProblem && !result.problems.length) issues.push("they asked for an exercise: create it now with CREATE_PROBLEM (full statement, one short answer, a check expression for a numeric answer, precision and unit in the hint), then one line pointing them to it");
      if (asksToWrite(message) && !result.board.length) issues.push("they asked you to write it on the board: do it now (WRITE_TO_BOARD, clean maths in $…$, their numbers), then one short line");
      const doubt = doubtsRightAnswer(reply, message);
      if (doubt) issues.push(doubt);
      const badMath = wrongArithmetic(reply, message);
      if (badMath) issues.push(`it contains a wrong calculation: ${badMath}`);
      const ahead = asksForFormula(message) ? [] : equationsAhead(reply, said);
      if (ahead.length) issues.push(`it hands them an equation they haven't stated (${ahead.join("; ")}) — don't derive it or name the formula; ask what relationship they'd use`);
      const invented = inventedNumbers(reply, [...said, ...allBoard().map((b) => b.text), ...allProblems().map((p) => p.question)]);
      if (invented.length) issues.push(`it uses numbers nobody gave (${invented.slice(0, 3).join(", ")}) — only their numbers and the problem's; never compute ahead or bring in a new scenario`);
      if (!doubt && confirmsUnchecked(reply, message, input.stepVerdict ? { studentStep: { status: input.stepVerdict.verdict } } : null)) issues.push("it confirms a value they didn't actually give (or one that's wrong) — react to THEIR number, and if it's off, ask which step they'd recheck");
      if (wrapsUpUnasked(reply, message)) issues.push("it offers to wrap up or move on, which they didn't ask for — stay on the current work");
      if (blamesWidget(reply)) issues.push("it blames the app/widget — if an exercise's key disagrees with a right answer, say plainly the key was wrong");
      if (issues.length && !corrected && !lastRound) {
        corrected = true;
        messages.push({ role: "assistant", content: text });
        messages.push({ role: "user", content: `(Fix your reply before the student sees it:\n- ${issues.join("\n- ")}\nThen send the corrected reply. Don't mention this note.)` });
        continue;
      }
      if (leaked) { result.guardrailTripped = true; result.reply = socraticFallback(fr); return result; }
      result.reply = reply;
      return result;
    }

    messages.push({ role: "assistant", content: text, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      const args = parseToolArgs(tc.function?.arguments) || {};
      let content: string;
      try { content = applyTool(name, args, { message, result, allBoard, allProblems, spokenRepair, fr, said, wantsExercise: wantsProblem }); }
      catch (e: any) { content = `ERROR: ${e?.message || e}`; }
      messages.push({ role: "tool", tool_call_id: tc.id, content });
    }
  }
  result.error = !result.reply;
  return result;
}

// ── Tool handling ─────────────────────────────────────────────────────────────────────────────────────
interface ToolCtx {
  message: string;
  result: TutorTurnResult;
  allBoard: () => BoardEntry[];
  allProblems: () => TaskProblem[];
  spokenRepair: SpokenRepair | null;
  fr: boolean;
  /** Everything the student has said this session (and problems already posted) — the only legitimate source of givens. */
  said: string[];
  wantsExercise: boolean;
}
const LEAK = "REJECTED: that shows the answer to an open problem or gap — they must find it. Leave that value out (use '?').";
const ok = (id?: string) => JSON.stringify({ ok: true, ...(id ? { id } : {}) });

/** Apply one board tool call; returns the tool result text the model reads. Exported for tests. */
export function applyTool(name: string, input: any, c: ToolCtx): string {
  const { result } = c;
  const openProblems = () => c.allProblems().filter((p) => !p.solved);
  const leaks = (s: string) => {
    if (leaksAnyProblemAnswer(s, openProblems())) return true;
    return c.allBoard().some((g) => g.kind === "gap" && g.expectedAnswer && g.status !== "correct" && replyStatesValue(s, g.expectedAnswer) && !replyStatesValue(c.message, g.expectedAnswer));
  };
  const push = (e: BoardEntry) => { result.board.push(e); return ok(e.id); };
  const count = (kind: string) => result.board.filter((e) => e.kind === kind).length;

  switch (name) {
    case "WRITE_TO_BOARD": {
      if (typeof input.text === "string") input.text = latexifyBoardLine(repairLatex(input.text), String(input.kind || ""));
      const text = String(input.text || "");
      if (result.board.length >= 8) return "LIMIT: that's plenty on the board for one turn.";
      if (isDuplicateBoardEntry(c.allBoard(), input)) return "DUPLICATE: that's already on the board — point at it instead.";
      if (input.kind !== "gap" && leaks(text)) return LEAK;
      // A gap that already shows its own answer ("Power = 1000×9.8×sin(10°)×15 = 25,526?", reported live) isn't a gap.
      const unsep = (x: string) => x.replace(/(\d)[\s,](?=\d{3}(?!\d))/g, "$1");
      if (input.kind === "gap" && input.expectedAnswer && replyStatesValue(unsep(text.replace(/=\s*\?\s*\$?\s*$/, "")), unsep(String(input.expectedAnswer)))) return "REJECTED: that gap line already shows its own answer — end it at '= ?', and leave the working for them.";
      // A problem is posted with CREATE_PROBLEM (answer box, checked key) — never as board text plus a "= ?" gap.
      if (input.owner !== "student" && c.wantsExercise && !result.problems.length && (input.kind === "gap" || looksLikeGivensOrScenario(text)))
        return "REJECTED: they asked for an exercise — post it with CREATE_PROBLEM (the full statement, one short answer, a check expression, precision and unit in the hint), not as board text.";
      if (input.owner !== "student" && inventsProblemOnBoard(text, [...c.said, ...result.problems.map((q) => q.question)]))
        return "REJECTED: that sets up a problem the student never gave. A new problem goes through CREATE_PROBLEM, and only when they ask for one; the board's givens come from THEIR problem.";
      // Never derive an equation or show which formula to use: the student names the relationship first.
      const ahead = input.owner !== "student" && !asksForFormula(c.message) ? equationsAhead(text, c.said) : [];
      if (ahead.length) return `REJECTED: that writes an equation they haven't stated (${ahead[0]}). Don't derive it or show which formula to use — ask them what relationship they'd use, and write it up once THEY say it.`;
      const heard = boardRepeatsMishearing(text, c.spokenRepair);
      if (heard) return `REJECTED: "${heard}" is a speech-recognition slip — write what the student MEANT, typeset in $…$.`;
      const r = makeBoardEntry(input);
      return "error" in r ? r.error : push(r.entry);
    }
    case "CREATE_PROBLEM": {
      if (openProblems().length && !asksToMoveOn(c.message)) return "REJECTED: they haven't answered the problem already on the board — help them with that one first.";
      if (isDuplicateProblem(c.allProblems(), input)) return "DUPLICATE: that problem is already on the board.";
      // requireCheck: a numeric key must come with an expression the app evaluates itself (never a guessed key).
      const r = makeProblem(input, true);
      if ("error" in r) return r.error;
      result.problems.push(r.problem);
      return ok(r.problem.id);
    }
    case "ANNOTATE_BOARD": {
      const hit = resolveBoardTarget(String(input.target || ""), c.allBoard());
      const note = String(input.note || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!hit?.id) return "ERROR: no such board entry — use a #n from the board listing.";
      if (!note) return "ERROR: a pointer needs a short note.";
      if (count("annotation") >= 2) return "LIMIT: two pointers per turn is plenty.";
      if (leaks(note)) return LEAK;
      if (!asksForFormula(c.message) && equationsAhead(note, c.said).length) return "REJECTED: that note hands them an equation they haven't stated — point and ask instead.";
      const tone = ["error", "hint", "good", "focus"].includes(input.tone) ? input.tone : "focus";
      return push({ id: randomUUID(), text: note, kind: "annotation", targetId: hit.id, tone, owner: "otto", at: new Date().toISOString() } as BoardEntry);
    }
    case "GEOMETRY_ON_BOARD": {
      if (count("diagram") >= 2) return "LIMIT: enough figures for one turn.";
      if (leaks(JSON.stringify(input))) return LEAK;
      const r = makeGeometryEntry(input);
      if ("error" in r) return r.error;
      if (isDuplicateDiagram(c.allBoard(), r.entry)) return "DUPLICATE: that figure is already on the board.";
      return push(r.entry);
    }
    case "TRIG_SCENE_ON_BOARD": {
      if (count("svg") >= 2) return "LIMIT: enough figures for one turn.";
      const built = buildTrigScene({ mode: input.mode, observers: Array.isArray(input.observers) ? input.observers : [], separation: input.separation, towerHeight: input.towerHeight, unknownTop: typeof input.unknownTop === "string" ? input.unknownTop.slice(0, 3) : undefined, distance: input.distance, baseName: input.baseName, topName: input.topName, units: input.units });
      if ("error" in built) return built.error;
      const svg = sanitizeSvg(built.svg);
      if (!svg) return "ERROR: couldn't build that scene.";
      const caption = String(input.caption || "").trim().slice(0, 200) || (c.fr ? "La situation" : "The situation");
      result.board.push({ id: randomUUID(), text: caption, kind: "svg", svg, facts: built.facts, at: new Date().toISOString() } as BoardEntry);
      return JSON.stringify({ ok: true, geometry: built.facts, note: "Drawn to scale with only the given angles marked." });
    }
    case "GRAPH_ON_BOARD": {
      if (count("graph") >= 2) return "LIMIT: enough graphs for one turn.";
      if (leaks(JSON.stringify(input))) return LEAK;
      const r = makeGraphEntry(input);
      return "error" in r ? r.error : push(r.entry);
    }
    case "SVG_ON_BOARD": {
      if (count("svg") >= 2) return "LIMIT: enough figures for one turn.";
      if (leaks(`${input.caption || ""} ${svgText(sanitizeSvg(String(input.svg || "")))}`)) return "REJECTED: that figure labels the answer — show the unknown as '?'.";
      const r = makeSvgEntry(input);
      return "error" in r ? r.error : push(r.entry);
    }
    case "FLOW_ON_BOARD": {
      if (count("flow") >= 2) return "LIMIT: enough diagrams for one turn.";
      if (leaks(JSON.stringify(input))) return LEAK;
      const r = makeFlowEntry(input);
      return "error" in r ? r.error : push(r.entry);
    }
    case "WIDGET_ON_BOARD": {
      if (count("widget") >= 1) return "LIMIT: one activity at a time.";
      if (leaks(JSON.stringify(input))) return LEAK;
      const r = makeWidgetEntry(input);
      return "error" in r ? r.error : push(r.entry);
    }
    case "CREATE_INTERACTIVE": {
      if (count("interactive") >= 1) return "LIMIT: one interactive scene per turn.";
      if (leaks(`${input.caption || ""} ${input.html || ""}`)) return LEAK;
      const r = makeInteractiveEntry(input);
      return "error" in r ? r.error : push(r.entry);
    }
    case "SET_OBJECTIVES": {
      const r = makeObjectives(input);
      if ("error" in r) return r.error;
      result.objectives = r.objectives;
      return ok();
    }
    case "CLEAR_BOARD": {
      const focus = input.keepFocus !== false ? c.allBoard().find((e) => e.kind === "focus") : undefined;
      result.boardCleared = true;
      result.board = focus ? [focus] : [];
      return ok();
    }
    default:
      return `ERROR: unknown tool ${name}.`;
  }
}

// ── Subject detection (the session starts with one open question, no subject picker) ──────────────────
const SUBJECTS: [string, RegExp][] = [
  ["Math", /\b(math|maths|mathématiques|equation|équation|derivative|dérivée|integral|intégrale|fraction|algebra|algèbre|geometry|géométrie|trigo\w*|sin|cos|tan|triangle|polynom\w*|function|fonction|limit|limite|probabilit\w*|vector|vecteur|matrix|matrice|log|exponential|exponentielle|suite|sequence|quadratic|factor\w*|solve|résou\w*|calcul\w*)\b|[0-9]\s*[x²³]|[=+×÷^√∫]/i],
  ["Physics", /\b(physics|physique|force|velocity|vitesse|acceleration|accélération|newton|energy|énergie|momentum|circuit|voltage|tension|current|courant|wave|onde|optics|optique|gravity|gravité|friction|frottement|mécanique|kinematics)\b/i],
  ["Chemistry", /\b(chemistry|chimie|mole|molar|molaire|reaction|réaction|acid|acide|base|ph|oxid\w*|redox|atom\w*|molecul\w*|bond|liaison|stoichiometry|stœchiométrie|titration|titrage)\b/i],
  ["Biology", /\b(biology|biologie|svt|cell|cellule|dna|adn|gene|gène|protein|protéine|enzyme|evolution|évolution|photosynthesis|photosynthèse|mitosis|mitose|ecosystem|écosystème|neuron\w*)\b/i],
  ["History", /\b(history|histoire|war|guerre|revolution|révolution|empire|treaty|traité|century|siècle|cold war|guerre froide|napoleon|napoléon|wwi|wwii|colonial\w*)\b/i],
  ["Geography", /\b(geography|géographie|géo|climate|climat|population|urban\w*|territoire|territory|globalization|mondialisation)\b/i],
  ["Economics", /\b(economics|économie|ses|supply|offre|demand|demande|inflation|gdp|pib|market|marché|unemployment|chômage|elasticity|élasticité)\b/i],
  ["Philosophy", /\b(philosophy|philosophie|philo|kant|descartes|platon|plato|conscience|liberté|freedom|morale|ethics|éthique|vérité|truth)\b/i],
  ["English", /\b(english|anglais|essay|poem|poetry|novel|shakespeare|grammar|tense|vocabulary)\b/i],
  ["French", /\b(français|french|dissertation|commentaire|poème|roman|conjugaison|grammaire|orthographe)\b/i],
  ["Spanish", /\b(spanish|espagnol|español)\b/i],
  ["German", /\b(german|allemand|deutsch)\b/i],
  ["Computer Science", /\b(code|coding|programming|programmation|python|javascript|algorithm|algorithme|function\s*\(|loop|boucle|array|tableau en python)\b/i],
];
/** The subject a session is about, from what the student said — or undefined when nothing clearly names one.
 *  Explicit subject words win over incidental signals (an "=" sign in a chemistry question). Exported for tests. */
export function detectSubject(text: string): string | undefined {
  const s = String(text || "");
  const explicit = /\b(math|maths|mathématiques|physics|physique|chemistry|chimie|biology|biologie|svt|history|histoire|geography|géographie|economics|économie|ses|philosophy|philosophie|philo|english|anglais|français|french|spanish|espagnol|german|allemand)\b/i.exec(s)?.[1]?.toLowerCase();
  if (explicit) {
    const map: Record<string, string> = { math: "Math", maths: "Math", "mathématiques": "Math", physics: "Physics", physique: "Physics", chemistry: "Chemistry", chimie: "Chemistry", biology: "Biology", biologie: "Biology", svt: "Biology", history: "History", histoire: "History", geography: "Geography", "géographie": "Geography", economics: "Economics", "économie": "Economics", ses: "Economics", philosophy: "Philosophy", philosophie: "Philosophy", philo: "Philosophy", english: "English", anglais: "English", "français": "French", french: "French", spanish: "Spanish", espagnol: "Spanish", german: "German", allemand: "German" };
    return map[explicit];
  }
  // Otherwise the subject with the most distinct keyword hits; maths symbols alone only decide when nothing else matched.
  let best: string | undefined, bestHits = 0;
  for (const [name, re] of SUBJECTS) {
    const hits = new Set((s.match(new RegExp(re.source, "gi")) || []).map((m) => m.toLowerCase())).size;
    if (hits > bestHits) { best = name; bestHits = hits; }
  }
  return best;
}
