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
