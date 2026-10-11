// Bridges the live board (BoardEntry[], what the app stores and renders) and the structured board state (shared/boardState.ts),
// so the tutor's edits go through the validated action reducer: student work can't be overwritten, unknown targets error,
// every call returns a structured result. The stored shape does not change — only the rules around changing it.
import type { BoardEntry } from "./types.ts";
import { emptyBoard, applyBoardAction, type BoardAction, type BoardState, type ActionResult, type Author, type Engine } from "./boardState.ts";

const authorOf = (e: BoardEntry): Author => e.owner === "student" ? "student" : e.kind === "given" ? "problem" : "tutor";

/** Loads entries into a board state: each entry becomes one object with its own id (revision 1), in board order. Archived entries stay as archived. */
export function entriesToState(entries: BoardEntry[], problemId = "board", revision = 0): BoardState {
  const s = emptyBoard(problemId);
  s.revision = revision;
  for (const e of entries) {
    if (!e?.id) continue;
    const now = e.at || new Date(0).toISOString();
    s.objects[e.id] = {
      id: e.id, type: e.kind === "annotation" ? "annotation" : "text", author: authorOf(e),
      data: (e.kind === "annotation" ? { targetId: (e as any).targetId || "", text: e.text } : { text: e.text }) as never,
      revision: 1, createdAt: now, updatedAt: now, visible: true, dependsOn: [], verification: e.status === "correct" ? "verified" : e.status === "incorrect" ? "invalid" : "unverified",
      status: (e as any).archived ? "archived" : "active",
    };
    if (!(e as any).archived) s.order.push(e.id);
  }
  return s;
}

export interface EntryEdit { id: string; text?: string; archived?: boolean }
export type EntryActionResult = { ok: true; edits: EntryEdit[]; result: ActionResult } | { ok: false; code: string; message: string; result: ActionResult };

/** Applies an `update` (new text) or `remove` (archive) to one entry through the reducer. The tutor is the author, so student-owned entries are refused. */
export function applyEntryAction(entries: BoardEntry[], action: Extract<BoardAction, { action: "update" | "remove" }>, engine: Engine = {}): EntryActionResult {
  const { state, result } = applyBoardAction(entriesToState(entries), action, engine);
  if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message, result };
  const id = action.targetId;
  if (action.action === "update") return { ok: true, edits: [{ id, text: String((state.objects[id].data as any).text ?? "") }], result };
  return { ok: true, edits: [{ id, archived: true }], result };
}
