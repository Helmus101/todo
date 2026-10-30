// The tutor's own pen (shared/boardTool.ts): applies a write_board call to the board with the same guards the board writer uses, so a line the
// tutor writes is still refused when its arithmetic fails, when it is the answer to the question the tutor is asking, or when it is a rule the
// student has not reached yet. The reply goes back to the tutor model: what was written, what was refused and why, and the board as it now stands.
// Used by POST /api/tutor/live/write and by the simulator, so both run the same code.
import type { BoardEntry } from "../../shared/types.ts";
import { BOARD_TOOL_KINDS, boardListing, type BoardToolLine } from "../../shared/boardTool.ts";
import { boardLineNumbers } from "../../shared/boardLines.ts";
import { applyOps } from "./apply.ts";
import { boardLineIsWrong } from "../boardMath.ts";
import { answersOpenQuestion, hintedRuleHeld, splitOpenQuestion } from "./boardWriter.ts";
import { numbersSaid, plainDigits } from "./numbers.ts";

const FUNCS = /\\?(?:log|ln|sin|cos|tan|sqrt|frac|int|sum|lim|exp)\b|\be\^|\bderivative|\bintegral|\bpower|\bexponent|\bproduct|\bquotient|\bchain|\bmoles?\b|\bforce|\benergy|\bvelocity|\bacceleration/gi;
const funcsOf = (t: string) => new Set([...String(t || "").toLowerCase().matchAll(FUNCS)].map((m) => m[0].replace(/^\\/, "")));

/** The student has reached this rule themselves: their last words state an equality and share a function or quantity with it. Pure. */
export function studentArrivedAt(latex: string, studentWords: string[]): boolean {
  const last = studentWords.slice(-2).join(" ");
  if (!/=|\b(?:equals?|is the same as|becomes|gives|turns into|is just)\b/i.test(last)) return false;
  const a = funcsOf(latex), b = funcsOf(last);
  return [...a].some((f) => b.has(f));
}

/** Numbers the student said (or that are already on the board), for "write only what they said". */
function studentNumbers(recent: string, board: BoardEntry[]): Set<number> {
  const said = recent.split("\n").filter((l) => /^Student:/i.test(l)).join(" ");
  return numbersSaid(`${said} ${board.map((e) => e.text || "").join(" ")}`);
}

/** Apply one write_board call. `recent` is the last few turns as "Student: …" / "Tutor: …" lines, including what the tutor is saying now. Pure apart from ids. */
export function applyBoardTool(input: { lines: BoardToolLine[]; board: BoardEntry[]; recent: string }): { written: BoardEntry[]; removed: string[]; refused: { line: string; reason: string }[]; listing: string } {
  const refused: { line: string; reason: string }[] = [];
  const removed: string[] = [];
  const recent = String(input.recent || "").slice(-4000);
  const studentWords = recent.split("\n").filter((l) => /^Student:/i.test(l)).map((l) => l.replace(/^Student:\s*/i, ""));
  // The question the tutor is waiting on: the open one in what it is saying now, else the one it asked last.
  const tutorLines = recent.split("\n").filter((l) => /^Tutor:/i.test(l));
  // Once the student has spoken after the tutor's question, that question is answered, not open: their reply is what gets written.
  const lastIsStudent = /^Student:/i.test(recent.trim().split("\n").pop() || "");
  const openQuestion = lastIsStudent ? "" : splitOpenQuestion(tutorLines.slice(-1).join("\n")).openQuestion;
  const knownStudent = studentNumbers(recent, input.board);
  let board = [...input.board];
  const nums = boardLineNumbers(board);
  const byNumber = new Map([...nums].map(([id, n]) => [n, id]));
  const ops: any[] = [];
  for (const raw of (Array.isArray(input.lines) ? input.lines : []).slice(0, 8)) {
    const kind = (BOARD_TOOL_KINDS as readonly string[]).includes(String(raw?.kind)) ? String(raw.kind) : "note";
    const text = String(raw?.latex || "").trim().slice(0, 400);
    if (!text) continue;
    const refuse = (reason: string) => refused.push({ line: text.slice(0, 160), reason });
    // Each $...$ part is checked on its own as well: words before the maths ("Example: $3 \times 4 = 13$") hide it from the whole-line check.
    const wrongMath = boardLineIsWrong(text) || [...text.matchAll(/\$([^$]+)\$/g)].some((m) => boardLineIsWrong(`$${m[1]}$`));
    if (kind !== "focus" && kind !== "given" && kind !== "definition" && wrongMath) { refuse("its arithmetic does not hold; recompute it before writing it"); continue; }
    if (["step", "result", "formula"].includes(kind) && openQuestion && answersOpenQuestion(text, openQuestion, knownStudent)) { refuse("it is the answer to the question you just asked; wait until the student says it"); continue; }
    if (["step", "result"].includes(kind)) {
      // The student's working holds only numbers they said (or that are on the board already): the next value is theirs to find.
      const stripped = plainDigits(text).replace(/\\text\{[^}]*\}/g, " ").replace(/\\[a-zA-Z]+/g, " ").replace(/_\{[^}]*\}|_\d+|\^\{[^}]*\}|\^\d+/g, " ").replace(/[A-Za-z]\d+|\d+[A-Za-z]/g, " ");
      const unsaid = [...stripped.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter((n) => n > 1 && !knownStudent.has(n));
      if (unsaid.length) { refuse(`the student has not said ${unsaid.join(", ")} yet; write their step after they say it (a worked example on another case is a "note")`); continue; }
    }
    if (["formula", "definition"].includes(kind) && hintedRuleHeld(kind, studentWords, openQuestion) && !studentArrivedAt(text, studentWords)) { refuse("the student has not reached or asked for this rule yet; let them find it, then write it"); continue; }
    // A correction replaces the wrong line.
    const target = raw?.replaces !== undefined && raw?.replaces !== null && String(raw.replaces).trim() ? byNumber.get(Number(String(raw.replaces).replace(/^#/, ""))) : undefined;
    if (target) { removed.push(target); board = board.filter((e) => e.id !== target); }
    // "step" is the tool's word for a line of the student's working; on the board that is a "result" line (the kinds the board knows).
    ops.push(kind === "focus" ? { op: "topic", cue: 0, text } : { op: "step", cue: 0, kind: kind === "step" ? "result" : kind, text });
  }
  const applied = applyOps(ops, { board, problems: [], theirWords: [], pen: true });
  for (const d of applied.dropped) refused.push({ line: "", reason: d.replace(/^(?:step|topic): /, "") });
  const after = [...board, ...applied.board];
  return { written: applied.board, removed, refused, listing: boardListing(after) };
}
