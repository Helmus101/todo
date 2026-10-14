// The board's visible line numbers — ONE numbering shared by what the student sees in the margin and what the
// tutor reads ("#4"), so "look at line 4" always points at a line they can actually find. (Reported live: Otto
// said "it's already on the board — line 40" on a board that showed no numbers at all.)
import type { BoardEntry } from "./types.ts";

/** Entry id → its line number. Numbered in the order the board shows them (by time, ties kept in list order);
 *  the session focus, annotations (pointers drawn on another line) and problem placeholders get no number. */
export function boardLineNumbers(entries: Pick<BoardEntry, "id" | "kind" | "at">[]): Map<string, number> {
  const seen = new Set<string>();
  const lines = entries
    .map((e, i) => ({ e, i, t: Date.parse(e.at || "") || Number.MAX_SAFE_INTEGER }))
    .filter(({ e }) => e && !seen.has(e.id) && seen.add(e.id) && e.kind !== "focus" && e.kind !== "annotation" && (e.kind as string) !== "problem")
    .sort((a, b) => a.t - b.t || a.i - b.i);
  return new Map(lines.map(({ e }, k) => [e.id, k + 1]));
}

const STOP = new Set("that this with have from what when where which their there about would could should these those them they then than just also into your yours been were will the and for are but not you can how why does each other step line board look have here".split(" "));
const stems = (t: string) => new Set(String(t || "").toLowerCase().replace(/\$[^$]*\$/g, " ").split(/[^\p{L}\p{N}]+/u).filter((w) => (w.length >= 4 && !STOP.has(w)) || /^\d{2,}$/.test(w)).map((w) => w.slice(0, 5)));

/** The reply points at a numbered line that is about something else than the conversation: none of that line's words
 *  appear in `context` (the last few turns, without the reply itself). Returns the line number and its text, or null.
 *  (Reported live: after a detour into consumer surplus, Otto said "look at line 13 — carry out that division", an
 *  old polynomial-division line.) Exported for tests. */
export function pointsAtOffTopicLine(reply: string, board: Pick<BoardEntry, "id" | "kind" | "at" | "text">[], context: string): { n: number; text: string } | null {
  const nums = boardLineNumbers(board);
  const byN = new Map([...nums].map(([id, n]) => [n, board.find((e) => e.id === id)!]));
  const ctx = stems(context);
  if (!ctx.size) return null;
  for (const m of String(reply || "").matchAll(/\b(?:line|ligne)\s*(?:#|n°)?\s*(\d{1,3})\b|#(\d{1,3})\b/gi)) {
    const e = byN.get(Number(m[1] || m[2]));
    if (!e) continue;
    const words = stems(e.text);
    if (words.size >= 1 && String(e.text).length >= 15 && ![...words].some((w) => ctx.has(w))) return { n: Number(m[1] || m[2]), text: String(e.text).slice(0, 80) };
  }
  return null;
}

/** "Look at line 3" when the board's margin numbers stop before 3 → that number (else 0). */
export function citesMissingBoardLine(reply: string, board: Pick<BoardEntry, "id" | "kind" | "at">[]): number {
  const max = boardLineNumbers(board).size;
  for (const m of String(reply || "").matchAll(/\b(?:line|ligne)\s*(?:#|n°)?\s*(\d{1,3})\b|#(\d{1,3})\b/gi)) {
    const n = Number(m[1] || m[2]);
    if (n > max) return n;
  }
  return 0;
}
