// The Otto board as STATE: typed objects with stable ids, a validated action API, dependency-aware staleness, revisions and undo.
// Pure and dependency-free (the calculation engine is injected), so the server, the client and the tests all run the same rules.
// See docs/board-spec.md for the full specification; this file is the concrete schema + reducer.
//
// Rules the reducer enforces (each is an acceptance test in tests/run.mjs):
//   · every object has an id, a type, an author and a per-object revision; nothing is ever "regenerated";
//   · the tutor can never overwrite or delete student work (FORBIDDEN_STUDENT_WORK) — it annotates or adds a correction beside it;
//   · an action may carry `baseRevision`; if the board moved on, it is rejected (STALE_REVISION) instead of clobbering newer work;
//   · changing an object marks everything that depends on it "stale" (never shown as verified);
//   · hidden objects stay out of the student's view until revealed;
//   · every action returns a structured result; nothing is claimed that the result doesn't confirm.

export type Author = "problem" | "student" | "tutor" | "system";
export type Verification = "unverified" | "verified" | "invalid" | "stale";
export type ObjectType =
  | "problem" | "text" | "equation" | "calculation_step" | "diagram" | "vector" | "shape" | "graph"
  | "interactive_widget" | "annotation" | "highlight" | "result" | "hint" | "section";

export interface Given { name: string; value: number | string; unit?: string }
interface WidgetParam { name: string; value: number; min: number; max: number; unit?: string; fixed?: boolean }

/** The type-specific payload of each object kind. */
export interface ObjectData {
  problem: { statement: string; givens: Given[]; task?: string; sourceUrl?: string };
  text: { text: string };
  equation: { latex: string; expr?: string };
  /** One linked step of a calculation: formula → substitution → result (+unit). `expr` is what the engine evaluates. */
  calculation_step: { formula: string; substituted?: string; expr?: string; result?: number | string; unit?: string; explanation?: string };
  diagram: { caption: string; svg?: string; parts?: string[] };
  /** A force/displacement/etc. as its own object — a COMPONENT is a separate vector whose `componentOf` names the full one. */
  vector: { label: string; origin?: { x: number; y: number }; directionDeg: number; magnitude?: number; unit?: string; frame?: string; componentOf?: string };
  shape: { kind: string; vertices?: { name: string; x: number; y: number }[]; angles?: { at: string; deg: number; given: boolean }[]; schematic?: boolean };
  graph: { expr: string; xLabel?: string; yLabel?: string; domain?: [number, number]; units?: { x?: string; y?: string } };
  interactive_widget: { caption: string; params: WidgetParam[]; drives?: string[] };
  annotation: { targetId: string; text: string; compareWith?: string };
  highlight: { targetId: string; part?: string; persistent: boolean };
  result: { value: number | string; unit?: string; label?: string };
  hint: { text: string; level: number };
  section: { title: string };
}
type DataOf<T extends ObjectType> = ObjectData[T];

export interface BoardObject<T extends ObjectType = ObjectType> {
  id: string;
  type: T;
  author: Author;
  data: DataOf<T>;
  /** Per-object revision: +1 on every change. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Group this object belongs to (a "section" object id), if any. */
  section?: string;
  /** false = hidden from the student until revealed (progressive disclosure). */
  visible: boolean;
  /** ids this object is computed from; changing one marks this stale. */
  dependsOn: string[];
  verification: Verification;
  /** Soft-removed objects stay in the state so undo works; archived ones leave the active workspace but are kept. */
  status: "active" | "archived" | "removed";
}

export interface RevisionRecord {
  revision: number;
  action: string;
  author: Author;
  at: string;
  /** Objects as they were BEFORE this revision (null = didn't exist) — what undo restores. */
  before: Record<string, BoardObject | null>;
  /** Previous order/focus, for undo. */
  beforeOrder: string[];
  beforeFocus: string | null;
}

export interface BoardState {
  problemId: string;
  /** Global revision: +1 per successful state-changing action. */
  revision: number;
  objects: Record<string, BoardObject>;
  /** Display order of active objects (the layout engine's input). */
  order: string[];
  /** The object under discussion right now (temporary emphasis lives in `highlight` objects, never in the content). */
  focusId: string | null;
  history: RevisionRecord[];
}

// ── Action payloads (what the tutor — or a student gesture — sends) ───────────────────────────────────
interface ActionBase { /** the board revision the sender was looking at; rejected if the board has moved on */ baseRevision?: number; author?: Author }
export type NewObject = { [T in ObjectType]: { type: T; data: DataOf<T>; id?: string; section?: string; visible?: boolean; dependsOn?: string[] } }[ObjectType];

export type BoardAction =
  | (ActionBase & { action: "inspect"; ids?: string[]; types?: ObjectType[]; author?: Author; view?: "tutor" | "student" })
  | (ActionBase & { action: "create"; object: NewObject; after?: string })
  | (ActionBase & { action: "focus"; targetId: string })
  | (ActionBase & { action: "highlight"; targetId: string; part?: string; persistent?: boolean })
  | (ActionBase & { action: "annotate"; targetId: string; text: string })
  | (ActionBase & { action: "update"; targetId: string; patch: Record<string, unknown>; expectedObjectRevision?: number })
  | (ActionBase & { action: "append_step"; section?: string; step: ObjectData["calculation_step"]; dependsOn?: string[] })
  | (ActionBase & { action: "reveal"; targetIds?: string[]; all?: boolean })
  | (ActionBase & { action: "validate"; targetId: string })
  | (ActionBase & { action: "compare"; leftId: string; rightId: string; text: string })
  | (ActionBase & { action: "remove"; targetId: string })
  | (ActionBase & { action: "organize"; order: string[] })
  | (ActionBase & { action: "archive"; targetIds: string[] })
  | (ActionBase & { action: "reset"; scope: "section" | "exercise"; section?: string })
  | (ActionBase & { action: "undo" });

export type ErrorCode = "NOT_FOUND" | "STALE_REVISION" | "FORBIDDEN_STUDENT_WORK" | "INVALID_PAYLOAD" | "SCOPE_REQUIRED" | "NOTHING_TO_UNDO" | "DUPLICATE" | "UNSUPPORTED";
export type ActionResult =
  | { ok: true; revision: number; changed: string[]; stale: string[]; object?: BoardObject; snapshot?: BoardSnapshot; note?: string }
  | { ok: false; error: { code: ErrorCode; message: string; targetId?: string; currentRevision: number } };

/** What the tutor reads: compact, ids + types + content, status and relations — full objects only on request. */
export interface BoardSnapshot {
  revision: number;
  problemId: string;
  focusId: string | null;
  objects: { id: string; type: ObjectType; author: Author; summary: string; revision: number; verification: Verification; visible: boolean; dependsOn: string[]; section?: string }[];
  hiddenCount: number;
}

export interface Engine {
  /** Deterministic evaluation of an expression ("15*4*cos(0)") → number, or null if it can't be computed. */
  evaluate?: (expr: string) => number | null;
  /** Validate an arithmetic claim (e.g., "3 * 47 = 141") and return whether it's correct */
  /** left/right are null when the side couldn't be parsed as a number (absent ≠ unparseable). */
  validateArithmetic?: (claim: string) => { correct: boolean; left?: number | null; right?: number | null; mismatch?: boolean } | null;
  /** Compile a math expression for evaluation with variables */
  compileExpression?: (expr: string, vars: string[]) => { fn: (v: Record<string, number>) => number } | { error: string };
  now?: () => string;
  newId?: () => string;
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────
export function emptyBoard(problemId: string): BoardState {
  return { problemId, revision: 0, objects: {}, order: [], focusId: null, history: [] };
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
let idCounter = 0;
const defaultId = () => `obj_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
const fail = (s: BoardState, code: ErrorCode, message: string, targetId?: string): ActionResult => ({ ok: false, error: { code, message, targetId, currentRevision: s.revision } });
/** Generated SVG is data, never code: no scripts, event handlers, foreignObject or javascript: links. */
function svgIsSafe(svg: string): boolean {
  return !/<\s*script|<\s*foreignObject|\son[a-z]+\s*=|javascript:|<\s*iframe|<\s*object|<\s*embed/i.test(svg);
}
export function summarize(o: BoardObject): string {
  const d: any = o.data;
  switch (o.type) {
    case "problem": return String(d.statement).slice(0, 120);
    case "text": return String(d.text).slice(0, 120);
    case "equation": return String(d.latex).slice(0, 120);
    case "calculation_step": return `${d.formula}${d.substituted ? ` → ${d.substituted}` : ""}${d.result !== undefined ? ` = ${d.result}${d.unit ? ` ${d.unit}` : ""}` : ""}`.slice(0, 160);
    case "vector": return `${d.label} @ ${d.directionDeg}°${d.magnitude !== undefined ? `, ${d.magnitude}${d.unit || ""}` : ""}${d.componentOf ? ` (component of ${d.componentOf})` : ""}`;
    case "annotation": return `on ${d.targetId}: ${String(d.text).slice(0, 80)}`;
    case "highlight": return `on ${d.targetId}${d.part ? ` (${d.part})` : ""}`;
    case "result": return `${d.label ? d.label + " = " : ""}${d.value}${d.unit ? ` ${d.unit}` : ""}`;
    case "hint": return `hint ${d.level}: ${String(d.text).slice(0, 80)}`;
    case "section": return String(d.title);
    case "diagram": return String(d.caption).slice(0, 100);
    case "graph": return `y = ${d.expr}`;
    case "shape": return String(d.kind);
    case "interactive_widget": return String(d.caption).slice(0, 100);
  }
}
/** Active, student-visible objects (or everything active, for the tutor). */
export function boardSnapshot(s: BoardState, view: "tutor" | "student" = "tutor", filter?: { ids?: string[]; types?: ObjectType[]; author?: Author }): BoardSnapshot {
  const all = s.order.map((id) => s.objects[id]).filter((o) => o && o.status === "active");
  const shown = all.filter((o) => view === "tutor" || o.visible)
    .filter((o) => !filter?.ids || filter.ids.includes(o.id)).filter((o) => !filter?.types || filter.types.includes(o.type)).filter((o) => !filter?.author || o.author === filter.author);
  return {
    revision: s.revision, problemId: s.problemId, focusId: s.focusId,
    objects: shown.map((o) => ({ id: o.id, type: o.type, author: o.author, summary: summarize(o), revision: o.revision, verification: o.verification, visible: o.visible, dependsOn: o.dependsOn, section: o.section })),
    hiddenCount: view === "student" ? all.filter((o) => !o.visible).length : 0,
  };
}
function dependentsOf(s: BoardState, id: string): string[] {
  const out = new Set<string>();
  const walk = (x: string) => { for (const o of Object.values(s.objects)) if (o.status === "active" && o.dependsOn.includes(x) && !out.has(o.id)) { out.add(o.id); walk(o.id); } };
  walk(id);
  return [...out];
}

// ── the reducer ─────────────────────────────────────────────────────────────────────────────────────────
/** Applies one action to the board. Returns the NEW state (the input is never mutated) and a structured result. */
export function applyBoardAction(prev: BoardState, a: BoardAction, engine: Engine = {}): { state: BoardState; result: ActionResult } {
  const now = engine.now?.() ?? new Date().toISOString();
  const newId = engine.newId ?? defaultId;
  const author: Author = a.author ?? "tutor";
  const s = clone(prev);
  const reject = (code: ErrorCode, message: string, targetId?: string) => ({ state: prev, result: fail(prev, code, message, targetId) });

  if (a.action === "inspect") {
    return { state: prev, result: { ok: true, revision: prev.revision, changed: [], stale: [], snapshot: boardSnapshot(prev, a.view ?? "tutor", { ids: a.ids, types: a.types, author: a.author }) } };
  }
  if (a.baseRevision !== undefined && a.baseRevision !== prev.revision && a.action !== "undo") {
    return reject("STALE_REVISION", `the board is at revision ${prev.revision}, you were looking at ${a.baseRevision} — inspect it again`);
  }
  const before: Record<string, BoardObject | null> = {};
  const touch = (id: string) => { if (!(id in before)) before[id] = s.objects[id] ? clone(s.objects[id]) : null; };
  const getActive = (id: string): BoardObject | null => { const o = s.objects[id]; return o && o.status !== "removed" ? o : null; };
  const bump = (o: BoardObject) => { o.revision += 1; o.updatedAt = now; };
  const staleDependents = (id: string, stale: string[]) => {
    for (const d of dependentsOf(s, id)) { touch(d); const o = s.objects[d]; if (o.verification === "verified" || o.verification === "unverified") { o.verification = "stale"; bump(o); stale.push(d); } }
  };
  const record = (changed: string[], stale: string[], object?: BoardObject, note?: string) => {
    s.revision += 1;
    s.history.push({ revision: s.revision, action: a.action, author, at: now, before, beforeOrder: prev.order.slice(), beforeFocus: prev.focusId });
    return { state: s, result: { ok: true as const, revision: s.revision, changed, stale, object: object ? clone(object) : undefined, note } };
  };
  const mustTarget = (id: string): BoardObject | null => getActive(id);

  switch (a.action) {
    case "create": {
      const spec = a.object;
      if (!spec || !spec.type || !spec.data) return reject("INVALID_PAYLOAD", "create needs object.type and object.data");
      if ((spec.data as any).svg && !svgIsSafe(String((spec.data as any).svg))) return reject("INVALID_PAYLOAD", "diagram svg contains script, event handlers or embedded objects");
      const id = spec.id ?? newId();
      if (s.objects[id]) return reject("DUPLICATE", `an object with id ${id} already exists — update it instead`, id);
      // The same problem is never added twice just because it is referenced again.
      if (spec.type === "problem" && Object.values(s.objects).some((o) => o.type === "problem" && o.status === "active" && (o.data as any).statement === (spec.data as any).statement)) return reject("DUPLICATE", "that problem is already on the board — focus it instead");
      for (const dep of spec.dependsOn ?? []) if (!getActive(dep)) return reject("NOT_FOUND", `dependsOn ${dep} doesn't exist`, dep);
      if (spec.section && !getActive(spec.section)) return reject("NOT_FOUND", `section ${spec.section} doesn't exist`, spec.section);
      touch(id);
      const o: BoardObject = { id, type: spec.type, author: spec.type === "problem" && (a.author === undefined || a.author === "system") ? "problem" : author, data: clone(spec.data) as never, revision: 1, createdAt: now, updatedAt: now, section: spec.section, visible: spec.visible ?? true, dependsOn: spec.dependsOn ?? [], verification: "unverified", status: "active" };
      s.objects[id] = o;
      const at = a.after ? s.order.indexOf(a.after) : -1;
      if (at >= 0) s.order.splice(at + 1, 0, id); else s.order.push(id);
      return record([id], [], o);
    }
    case "focus": {
      const o = mustTarget(a.targetId); if (!o) return reject("NOT_FOUND", `no object ${a.targetId}`, a.targetId);
      s.focusId = o.id;
      return record([], [], o);
    }
    case "highlight": {
      const t = mustTarget(a.targetId); if (!t) return reject("NOT_FOUND", `no object ${a.targetId}`, a.targetId);
      const id = newId(); touch(id);
      const h: BoardObject = { id, type: "highlight", author, data: { targetId: t.id, part: a.part, persistent: a.persistent ?? false } as never, revision: 1, createdAt: now, updatedAt: now, visible: true, dependsOn: [], verification: "verified", status: "active" };
      s.objects[id] = h; s.order.push(id); // the target itself is NOT touched or recreated
      return record([id], [], h);
    }
    case "annotate": {
      const t = mustTarget(a.targetId); if (!t) return reject("NOT_FOUND", `no object ${a.targetId}`, a.targetId);
      if (!a.text?.trim()) return reject("INVALID_PAYLOAD", "annotate needs text");
      const id = newId(); touch(id);
      const n: BoardObject = { id, type: "annotation", author, data: { targetId: t.id, text: a.text.trim().slice(0, 300) } as never, revision: 1, createdAt: now, updatedAt: now, visible: true, dependsOn: [], verification: "verified", status: "active" };
      s.objects[id] = n;
      const at = s.order.indexOf(t.id); s.order.splice(at >= 0 ? at + 1 : s.order.length, 0, id); // sits right next to what it explains
      return record([id], [], n);
    }
    case "update": {
      const o = mustTarget(a.targetId); if (!o) return reject("NOT_FOUND", `no object ${a.targetId}`, a.targetId);
      if (o.author === "student" && author !== "student") return reject("FORBIDDEN_STUDENT_WORK", "the tutor can't change student work — annotate it, or add a correction beside it", o.id);
      if (a.expectedObjectRevision !== undefined && a.expectedObjectRevision !== o.revision) return reject("STALE_REVISION", `${o.id} is at revision ${o.revision}, not ${a.expectedObjectRevision}`, o.id);
      if (!a.patch || typeof a.patch !== "object" || !Object.keys(a.patch).length) return reject("INVALID_PAYLOAD", "update needs a non-empty patch");
      const allowed = new Set(Object.keys(o.data as object));
      for (const k of Object.keys(a.patch)) if (!allowed.has(k) && !(o.type === "calculation_step" || o.type === "equation" || o.type === "vector" || o.type === "result" || o.type === "text")) return reject("INVALID_PAYLOAD", `${o.type} has no field ${k}`, o.id);
      if (typeof (a.patch as any).svg === "string" && !svgIsSafe((a.patch as any).svg)) return reject("INVALID_PAYLOAD", "svg contains script, event handlers or embedded objects", o.id);
      touch(o.id); o.data = { ...(o.data as object), ...a.patch } as never; o.verification = "unverified"; bump(o);
      const stale: string[] = []; staleDependents(o.id, stale);
      return record([o.id], stale, o);
    }
    case "append_step": {
      if (!a.step?.formula) return reject("INVALID_PAYLOAD", "append_step needs step.formula");
      if (a.section && !getActive(a.section)) return reject("NOT_FOUND", `section ${a.section} doesn't exist`, a.section);
      for (const dep of a.dependsOn ?? []) if (!getActive(dep)) return reject("NOT_FOUND", `dependsOn ${dep} doesn't exist`, dep);
      const id = newId(); touch(id);
      const o: BoardObject = { id, type: "calculation_step", author, data: clone(a.step) as never, revision: 1, createdAt: now, updatedAt: now, section: a.section, visible: true, dependsOn: a.dependsOn ?? [], verification: "unverified", status: "active" };
      s.objects[id] = o;
      // goes after the last member of its section (or the end), never into the middle of other work
      const members = s.order.filter((x) => s.objects[x]?.section === a.section && a.section);
      const at = members.length ? s.order.indexOf(members[members.length - 1]) : -1;
      if (at >= 0) s.order.splice(at + 1, 0, id); else s.order.push(id);
      return record([id], [], o);
    }
    case "reveal": {
      const ids = a.all ? s.order.filter((x) => s.objects[x]?.status === "active" && !s.objects[x].visible) : (a.targetIds ?? []);
      if (!ids.length) return reject("INVALID_PAYLOAD", "reveal needs targetIds or all:true");
      for (const id of ids) if (!getActive(id)) return reject("NOT_FOUND", `no object ${id}`, id);
      const changed: string[] = [];
      for (const id of ids) { const o = s.objects[id]; if (o.visible) continue; touch(id); o.visible = true; bump(o); changed.push(id); }
      return record(changed, []);
    }
    case "validate": {
      const o = mustTarget(a.targetId); if (!o) return reject("NOT_FOUND", `no object ${a.targetId}`, a.targetId);
      if (o.type !== "calculation_step" && o.type !== "equation") return reject("UNSUPPORTED", `${o.type} can't be validated`, o.id);
      const d: any = o.data;
      const expr = String(d.expr ?? "");
      const got = expr && engine.evaluate ? engine.evaluate(expr) : null;
      touch(o.id);
      if (got === null || got === undefined) { o.verification = "unverified"; bump(o); return record([o.id], [], o, "the engine couldn't evaluate this — left unverified"); }
      const claimed = typeof d.result === "number" ? d.result : Number(d.result);
      const ok = Number.isFinite(claimed) ? Math.abs(got - claimed) <= 5e-3 * Math.max(1, Math.abs(got), Math.abs(claimed)) : false;
      o.verification = ok ? "verified" : "invalid"; bump(o);
      return record([o.id], [], o, ok ? undefined : `the engine computes ${got}`);
    }
    case "compare": {
      const l = mustTarget(a.leftId), r = mustTarget(a.rightId);
      if (!l || !r) return reject("NOT_FOUND", `no object ${!l ? a.leftId : a.rightId}`, !l ? a.leftId : a.rightId);
      const id = newId(); touch(id);
      const n: BoardObject = { id, type: "annotation", author, data: { targetId: l.id, compareWith: r.id, text: a.text } as never, revision: 1, createdAt: now, updatedAt: now, visible: true, dependsOn: [], verification: "verified", status: "active" };
      s.objects[id] = n; s.order.splice(Math.max(s.order.indexOf(l.id), s.order.indexOf(r.id)) + 1, 0, id);
      return record([id], [], n);
    }
    case "remove": {
      const o = mustTarget(a.targetId); if (!o) return reject("NOT_FOUND", `no object ${a.targetId}`, a.targetId);
      if (o.author === "student" && author !== "student") return reject("FORBIDDEN_STUDENT_WORK", "the tutor can't remove student work", o.id);
      touch(o.id); o.status = "removed"; bump(o);
      const stale: string[] = []; staleDependents(o.id, stale);
      s.order = s.order.filter((x) => x !== o.id); if (s.focusId === o.id) s.focusId = null;
      return record([o.id], stale);
    }
    case "organize": {
      const active = new Set(s.order);
      if (a.order.length !== s.order.length || a.order.some((x) => !active.has(x)) || new Set(a.order).size !== a.order.length) return reject("INVALID_PAYLOAD", "organize must list exactly the active objects, each once");
      s.order = a.order.slice(); // positions change; no object's content does
      return record([], []);
    }
    case "archive": {
      if (!a.targetIds?.length) return reject("INVALID_PAYLOAD", "archive needs targetIds");
      for (const id of a.targetIds) { const o = getActive(id); if (!o) return reject("NOT_FOUND", `no object ${id}`, id); if (o.author === "student" && author !== "student") return reject("FORBIDDEN_STUDENT_WORK", "the tutor can't archive student work", id); }
      for (const id of a.targetIds) { touch(id); s.objects[id].status = "archived"; bump(s.objects[id]); }
      s.order = s.order.filter((x) => !a.targetIds.includes(x));
      return record(a.targetIds.slice(), []);
    }
    case "reset": {
      if (a.scope !== "section" && a.scope !== "exercise") return reject("SCOPE_REQUIRED", "reset needs an explicit scope: section or exercise");
      if (a.scope === "section" && !a.section) return reject("SCOPE_REQUIRED", "reset scope 'section' needs a section id");
      const victims = s.order.filter((x) => { const o = s.objects[x]; return o && o.type !== "problem" && (a.scope === "exercise" || o.section === a.section || x === a.section); });
      // Student work is archived, never deleted: a reset must not destroy what they wrote.
      for (const id of victims) { touch(id); s.objects[id].status = s.objects[id].author === "student" ? "archived" : "removed"; bump(s.objects[id]); }
      s.order = s.order.filter((x) => !victims.includes(x)); s.focusId = victims.includes(s.focusId ?? "") ? null : s.focusId;
      return record(victims, []);
    }
    case "undo": {
      const last = s.history.pop();
      if (!last) return reject("NOTHING_TO_UNDO", "nothing to undo");
      for (const [id, obj] of Object.entries(last.before)) { if (obj === null) delete s.objects[id]; else s.objects[id] = obj; }
      s.order = last.beforeOrder; s.focusId = last.beforeFocus;
      s.revision += 1; // undo is itself a revision (history shrinks, the counter keeps moving)
      return { state: s, result: { ok: true, revision: s.revision, changed: Object.keys(last.before), stale: [] } };
    }
    default:
      return reject("UNSUPPORTED", `unknown action ${(a as any).action}`);
  }
}
