// Bridges the live board (BoardEntry[], what the app stores and renders) and the structured board state (shared/boardState.ts),
// so the tutor's edits go through the validated action reducer: student work can't be overwritten, unknown targets error,
// every call returns a structured result. The stored shape does not change — only the rules around changing it.
import type { BoardEntry } from "./types.ts";
import { emptyBoard, applyBoardAction, type BoardAction, type BoardState, type ActionResult, type Author, type Engine, type BoardSnapshot, type ObjectType } from "./boardState.ts";
import { createCalculationEngine } from "./calculationEngine.ts";

const authorOf = (e: BoardEntry): Author => e.owner === "student" ? "student" : e.kind === "given" ? "problem" : "tutor";

/** Map BoardEntry kind to ObjectType - Phase 1: simplified mapping, will be enhanced in Phase 3 */
function entryKindToType(kind: string): ObjectType {
  const map: Record<string, ObjectType> = {
    "note": "text",
    "instruction": "text",
    "given": "text",
    "result": "text",
    "formula": "equation",
    "summary": "text",
    "focus": "text",
    "insight": "text",
    "definition": "text",
    "diagram": "diagram",
    "outline": "text",
    "interactive": "interactive_widget",
    "graph": "graph",
    "widget": "interactive_widget",
    "flow": "diagram",
    "svg": "diagram",
    "gap": "text",
    "annotation": "annotation",
  };
  return map[kind] || "text";
}

/** Calculation engine with validation capabilities */
const calcEngine = createCalculationEngine();

/** Loads entries into a board state: each entry becomes one object with its own id (revision 1), in board order. Archived entries stay as archived. */
export function entriesToState(entries: BoardEntry[], problemId = "board", revision = 0): BoardState {
  const s = emptyBoard(problemId);
  s.revision = revision;
  for (const e of entries) {
    if (!e?.id) continue;
    const now = e.at || new Date(0).toISOString();
    const type = entryKindToType(e.kind || "note");
    const data: any = { text: e.text };
    
    // Handle special types with richer data — the payload travels with the object so a create → load round trip
    // (applyCreateAction → entriesToState) keeps the diagram ops / graph / widget instead of flattening them.
    if (type === "diagram") {
      data.caption = e.text;
      if (e.diagram) data.diagram = e.diagram;
      if (e.svg) data.svg = e.svg;
    } else if (type === "graph" && e.graph) {
      data.expr = e.graph.fns?.[0]?.expr || "";
      data.xLabel = e.graph.xLabel;
      data.yLabel = e.graph.yLabel;
    } else if (type === "interactive_widget" && e.widget) {
      data.caption = e.text;
      data.widget = e.widget;
      data.params = [];
    } else if (type === "equation") {
      data.latex = e.text;
    } else if (type === "annotation") {
      data.targetId = (e as any).targetId || "";
      data.text = e.text;
    }

    s.objects[e.id] = {
      id: e.id,
      type,
      author: authorOf(e),
      data,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      visible: true,
      dependsOn: [],
      verification: e.status === "correct" ? "verified" : e.status === "incorrect" ? "invalid" : "unverified",
      status: (e as any).archived ? "archived" : "active",
    };
    if (!(e as any).archived) s.order.push(e.id);
  }
  return s;
}

/** Reverse of `entryKindToType`: which BoardEntry kind carries a given object type. The entries world is coarser
 *  (no vectors, sections or hints), so those fold into the nearest representable kind. */
function objectTypeToKind(type: ObjectType): NonNullable<BoardEntry["kind"]> {
  const map: Record<ObjectType, NonNullable<BoardEntry["kind"]>> = {
    problem: "given",
    text: "note",
    equation: "formula",
    calculation_step: "formula",
    diagram: "diagram",
    vector: "diagram",
    shape: "diagram",
    graph: "graph",
    interactive_widget: "widget",
    annotation: "annotation",
    highlight: "note",
    result: "result",
    hint: "note",
    section: "outline",
  };
  return map[type] || "note";
}

/** Apply an action with the calculation engine for validation */
export function applyActionWithEngine(entries: BoardEntry[], action: BoardAction): { state: BoardState; result: ActionResult } {
  return applyBoardAction(entriesToState(entries), action, calcEngine);
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

/** Applies a `create` action through the reducer. Returns the new entry if successful. */
export function applyCreateAction(entries: BoardEntry[], action: Extract<BoardAction, { action: "create" }>, engine: Engine = {}): { ok: true; entry: BoardEntry; result: ActionResult } | { ok: false; code: string; message: string; result: ActionResult } {
  // The entries world stores the exercise as an ordinary line, so the reducer's problem-duplicate guard can't see
  // it. Asking for the same problem again must FOCUS the existing one — never draw a second copy of it.
  if (action.object?.type === "problem") {
    const stmt = String((action.object.data as any)?.statement ?? "").trim();
    const dupe = stmt && entries.some((e) => e && !e.archived && String(e.text ?? "").trim() === stmt);
    if (dupe) {
      const message = "that problem is already on the board — focus it instead";
      return { ok: false, code: "DUPLICATE", message, result: { ok: false, error: { code: "DUPLICATE", message, currentRevision: entries.length } } };
    }
  }
  const { state, result } = applyBoardAction(entriesToState(entries), action, engine);
  if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message, result };
  const obj = result.object;
  if (!obj) return { ok: false, code: "NO_OBJECT", message: "create succeeded but no object returned", result };
  // Convert BoardObject back to an entry, carrying the payload the entry world can actually hold — a diagram
  // entry that lost its ops would render as an empty box, so the visual payload travels with it.
  const d: any = obj.data;
  // A diagram carrying an SVG must land as kind "svg": that is the kind the board renders a figure from
  // (kind "diagram" renders DiagramOp[]), so the figure the tutor asked for is the one the student sees.
  const kind = obj.type === "diagram" && typeof d.svg === "string" && d.svg ? "svg" : objectTypeToKind(obj.type);
  const entry: BoardEntry = {
    id: obj.id,
    text: String(d.text ?? d.statement ?? d.latex ?? d.caption ?? d.label ?? d.formula ?? "").slice(0, 2000),
    kind,
    owner: obj.author === "student" ? "student" : "otto",
    at: obj.createdAt,
    status: obj.verification === "verified" ? "correct" : obj.verification === "invalid" ? "incorrect" : undefined,
    ...(obj.type === "diagram" && Array.isArray(d.diagram) ? { diagram: d.diagram } : {}),
    ...(obj.type === "diagram" && typeof d.svg === "string" && d.svg ? { svg: d.svg } : {}),
    ...(obj.type === "graph" && d.expr ? { graph: { fns: [{ expr: String(d.expr) }], xmin: Number.isFinite(d.xmin) ? d.xmin : -10, xmax: Number.isFinite(d.xmax) ? d.xmax : 10, ...(d.xLabel ? { xLabel: d.xLabel } : {}), ...(d.yLabel ? { yLabel: d.yLabel } : {}) } } : {}),
    ...(obj.type === "interactive_widget" && d.widget ? { widget: d.widget } : {}),
  };
  return { ok: true, entry, result };
}

/** Applies an `inspect` action and returns the board snapshot. */
export function applyInspectAction(entries: BoardEntry[], action: Extract<BoardAction, { action: "inspect" }>, engine: Engine = {}): { ok: true; snapshot: BoardSnapshot; result: ActionResult } | { ok: false; code: string; message: string; result: ActionResult } {
  const { state, result } = applyBoardAction(entriesToState(entries), action, engine);
  if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message, result };
  const snapshot = result.snapshot;
  if (!snapshot) return { ok: false, code: "NO_SNAPSHOT", message: "inspect succeeded but no snapshot returned", result };
  return { ok: true, snapshot, result };
}
