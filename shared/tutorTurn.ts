// THE TUTOR'S TURN, AS DATA. One model call returns this object (JSON), code checks it (server/tutorTurn/verify.ts),
// and the board ops become board entries (server/tutorTurn/apply.ts). Because the reply is structured, there are no
// tool calls to leak into the text, every board pointer names a real line, and the amount of help is a number code
// can hold to a limit — instead of dozens of regex guards trying to guess all of that from free text.
//
// Inspired by HeyAristotle's loop: interpret → diagnose → choose ONE teaching move at a support level → verify →
// speak while the board changes in step (each board op carries the sentence it belongs to, `cue`).

import { hideToolLeaks } from "./toolLeak.ts";
export const INTENTS = ["answer", "reasoning", "ask_why", "ask_explain", "write_my_work", "new_problem", "restart", "stuck", "check", "off_topic", "chat", "other"] as const;
export type Intent = (typeof INTENTS)[number];

/** The angle an explanation took. When one doesn't land, code tells the model which angles are already used up. */
export const ANGLES = ["picture", "numbers", "analogy", "smaller_step", "symbols", "contrast"] as const;
export type Angle = (typeof ANGLES)[number];

export const DIAGNOSES = ["correct", "partial", "misconception", "slip", "no_attempt", "unclear", "none"] as const;
export type DiagnosisStatus = (typeof DIAGNOSES)[number];

/** The fixed set of teaching moves, from least to most help. */
export const MOVES = ["elicit", "revoice", "confirm", "focus", "probe_why", "practice", "recap", "hint_concept", "correct_error", "hint_procedure", "worked_step", "explain", "worked_example"] as const;
export type Move = (typeof MOVES)[number];

/** How much of the thinking each move takes away from the student (0 = none, 5 = a full worked example).
 *  Code owns the limit (server/tutorTurn/policy.ts): support may rise by at most one level a turn unless the student
 *  is lost, asks for an explanation, or has been stuck — then explaining is allowed straight away. */
export const MOVE_SUPPORT: Record<Move, number> = {
  elicit: 0, revoice: 0, confirm: 0, focus: 1, probe_why: 1, practice: 1, recap: 1,
  hint_concept: 2, correct_error: 2, hint_procedure: 3, worked_step: 4, explain: 4, worked_example: 5,
};

export const STEP_KINDS = ["given", "formula", "definition", "result", "summary", "strategy", "insight", "note"] as const;
export const MARK_STYLES = ["circle", "underline", "box", "arrow", "cross", "tick"] as const;
export const MARK_TONES = ["error", "hint", "good", "focus"] as const;
export const SCENES = ["graph", "geometry", "incline", "trig", "flow", "table", "source", "widget", "svg", "numberline", "balance"] as const;
export const EXPECTS = ["open", "value", "choice", "yes_no", "board", "none"] as const;
export const BOARD_OPS = ["topic", "step", "gap", "mark", "draw", "problem", "plan"] as const;

export type MarkStyle = (typeof MARK_STYLES)[number];
export type Scene = (typeof SCENES)[number];

/** One board change. Flat on purpose (one `op` plus optional fields): every provider's JSON mode handles it. */
export interface BoardOp {
  op: (typeof BOARD_OPS)[number];
  /** Index of the `speech` sentence this change belongs to — the board animates when that sentence is spoken. */
  cue: number;
  /** topic: the header. step: the line (maths in $…$). gap: the line ending "= ?". draw: the caption. */
  text?: string;
  kind?: (typeof STEP_KINDS)[number];
  owner?: "student" | "otto";
  /** One plain sentence: what this line does and why it's allowed. */
  why?: string;
  /** gap: the answer the student should reach (never shown). */
  expected?: string;
  /** gap: 2–6 words naming the move ("divide both sides by 3"). */
  action?: string;
  /** mark: the board line it points at ("#4"). */
  target?: string;
  style?: MarkStyle;
  tone?: (typeof MARK_TONES)[number];
  /** mark: a short note beside the line (≤ 15 words, never the fix). */
  note?: string;
  /** mark: the exact bit of the line to circle/underline ("2x", "−T"). */
  part?: string;
  scene?: Scene;
  spec?: Record<string, unknown>;
  /** problem: an exercise with an answer box. */
  question?: string;
  answer?: string;
  check?: string;
  options?: string[];
  correct?: number;
  format?: string;
  hint?: string;
  rubric?: { required?: string[][]; misconceptions?: string[] };
  /** plan: 3–5 objective labels, in the student's language. */
  objectives?: string[];
}

export interface TurnOutput {
  /** What the student said or did, in a few words (the model's reading of it, which code can check). */
  heard: string;
  intent: Intent;
  diagnosis: { status: DiagnosisStatus; misconception?: string; prerequisite?: string };
  move: Move;
  support: number;
  /** The reply, one sentence per item, in order. At most one question, and it is the last sentence. */
  speech: string[];
  board: BoardOp[];
  /** How this turn explained or hinted (optional; recorded so the next turn can change angle). */
  angle?: Angle;
  /** What the student has just told us they want from the sitting (only the new facts; the app merges them). */
  goals?: { aim?: string; deadline?: string; hard?: string; minutes?: number };
  /** What kind of answer the student is expected to give next. */
  expects: (typeof EXPECTS)[number];
}

const str = (x: unknown, cap: number): string => hideToolLeaks(String(x ?? "")).replace(/\s+/g, " ").trim().slice(0, cap);
const pick = <T extends readonly string[]>(list: T, x: unknown, fallback: T[number]): T[number] => {
  const v = String(x ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (list as readonly string[]).includes(v) ? (v as T[number]) : fallback;
};
const optPick = <T extends readonly string[]>(list: T, x: unknown): T[number] | undefined => {
  const v = String(x ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (list as readonly string[]).includes(v) ? (v as T[number]) : undefined;
};

/** Split prose into sentences (the speech array may arrive as one string). */
export function sentences(text: string): string[] {
  return String(text || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?…])\s+(?=[A-ZÀ-Ý0-9$"“«(¿¡])/u).map((s) => s.trim()).filter(Boolean);
}

function normalizeOp(o: any, nSpeech: number): BoardOp | null {
  if (!o || typeof o !== "object") return null;
  const op = optPick(BOARD_OPS, o.op ?? o.type ?? o.action_type);
  if (!op) return null;
  const cueRaw = Number(o.cue);
  const out: BoardOp = { op, cue: Number.isFinite(cueRaw) ? Math.max(0, Math.min(Math.max(0, nSpeech - 1), Math.round(cueRaw))) : 0 };
  const text = str(o.text ?? o.latex ?? o.caption, 600);
  if (text) out.text = text;
  const kind = optPick(STEP_KINDS, o.kind);
  if (kind) out.kind = kind;
  if (o.owner === "student" || o.owner === "otto") out.owner = o.owner;
  const why = str(o.why, 220);
  if (why) out.why = why;
  const expected = str(o.expected ?? o.expectedAnswer, 200);
  if (expected) out.expected = expected;
  const action = str(o.action ?? o.gapAction, 80);
  if (action) out.action = action;
  const target = str(o.target, 40);
  if (target) out.target = target;
  const style = optPick(MARK_STYLES, o.style);
  if (style) out.style = style;
  const tone = optPick(MARK_TONES, o.tone);
  if (tone) out.tone = tone;
  const note = str(o.note ?? (op === "mark" ? o.text : ""), 200);
  if (note && op === "mark") { out.note = note; delete out.text; }
  const part = str(o.part, 80);
  if (part) out.part = part;
  const scene = optPick(SCENES, o.scene);
  if (scene) out.scene = scene;
  if (o.spec && typeof o.spec === "object" && !Array.isArray(o.spec)) out.spec = o.spec;
  for (const k of ["question", "answer", "check", "format", "hint"] as const) { const v = str(o[k], k === "question" ? 900 : 300); if (v) out[k] = v; }
  if (Array.isArray(o.options)) { const opts = o.options.map((x: unknown) => str(x, 300)).filter(Boolean).slice(0, 6); if (opts.length >= 2) out.options = opts; }
  if (Number.isInteger(o.correct)) out.correct = o.correct;
  if (o.rubric && typeof o.rubric === "object") out.rubric = o.rubric;
  if (Array.isArray(o.objectives)) { const ob = o.objectives.map((x: any) => str(typeof x === "string" ? x : x?.label, 120)).filter(Boolean).slice(0, 5); if (ob.length) out.objectives = ob; }
  return out;
}

/** Turn whatever JSON the model produced into a valid TurnOutput, or null when there's no usable reply at all.
 *  Lenient about shape (a string instead of an array, a synonym field name), strict about values (unknown enums fall
 *  back to safe defaults, numbers are clamped). Pure. */
export function normalizeTurn(raw: unknown): TurnOutput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as any;
  const speechRaw = Array.isArray(r.speech) ? r.speech.map((s: unknown) => str(s, 600)).filter(Boolean) : sentences(str(r.speech ?? r.reply ?? r.say, 2400));
  const speech = speechRaw.flatMap((s: string) => sentences(s)).slice(0, 8);
  if (!speech.length) return null;
  const d = r.diagnosis && typeof r.diagnosis === "object" ? r.diagnosis : {};
  const move = pick(MOVES, r.move, "elicit");
  const supportRaw = Number(r.support ?? r.support_level);
  return {
    heard: str(r.heard ?? r.interpretation?.heard, 240),
    intent: pick(INTENTS, r.intent ?? r.interpretation?.intent, "other"),
    diagnosis: {
      status: pick(DIAGNOSES, d.status ?? r.diagnosis, "none"),
      ...(str(d.misconception, 90) ? { misconception: str(d.misconception, 90) } : {}),
      ...(str(d.prerequisite, 90) ? { prerequisite: str(d.prerequisite, 90) } : {}),
    },
    move,
    support: Number.isFinite(supportRaw) ? Math.max(0, Math.min(5, Math.round(supportRaw))) : MOVE_SUPPORT[move],
    speech,
    board: (Array.isArray(r.board) ? r.board : Array.isArray(r.board_actions) ? r.board_actions : []).map((o: unknown) => normalizeOp(o, speech.length)).filter((o: BoardOp | null): o is BoardOp => !!o).slice(0, 8),
    ...(optPick(ANGLES, r.angle) ? { angle: optPick(ANGLES, r.angle) } : {}),
    ...(r.goals && typeof r.goals === "object" ? { goals: { ...(str(r.goals.aim, 160) ? { aim: str(r.goals.aim, 160) } : {}), ...(str(r.goals.deadline, 60) ? { deadline: str(r.goals.deadline, 60) } : {}), ...(str(r.goals.hard, 160) ? { hard: str(r.goals.hard, 160) } : {}), ...(Number(r.goals.minutes) > 0 ? { minutes: Number(r.goals.minutes) } : {}) } } : {}),
    expects: pick(EXPECTS, r.expects?.kind ?? r.expects, "open"),
  };
}

// LaTeX in a JSON string: models write "\\text{x}" with ONE backslash. JSON then reads \t as a TAB (so \text and \times come out as
// "<tab>ext" and "<tab>imes") and rejects \s, \c, \l… outright (so \sin or \theta makes the whole reply unparseable).
// This doubles every backslash that starts a LaTeX command and leaves the real JSON escapes alone. Pure.
const LATEX_BFNRT = /^(?:text|textbf|textit|times|tan|tanh|theta|tau|tfrac|tilde|to|top|therefore|triangle|frac|forall|beta|bar|begin|binom|bullet|because|bmod|bigg?|neq|ne|nu|nabla|not|neg|notin|ni|rho|right|rightarrow|Rightarrow|rangle|rfloor|rceil|nearrow|implies)(?![A-Za-z])/;
export function fixJsonBackslashes(raw: string): string {
  const s = String(raw || "");
  let out = "", inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inStr) { out += ch; if (ch === '"') inStr = true; continue; }
    if (ch === '"') { out += ch; inStr = false; continue; }
    if (ch !== "\\") { out += ch; continue; }
    const nx = s[i + 1];
    if (nx === undefined) { out += "\\\\"; continue; }
    if (nx === "\\") { out += "\\\\"; i++; continue; }          // an already-doubled backslash: keep the pair
    if (nx === '"' || nx === "/") { out += ch + nx; i++; continue; }
    if (nx === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { out += ch; continue; }
    if ("bfnrt".includes(nx)) { out += LATEX_BFNRT.test(s.slice(i + 1)) ? "\\\\" : ch; continue; }   // \n / \t only when it is not a LaTeX command
    out += "\\\\";                                                // \sin, \sqrt, \Delta, \( … → a literal backslash
  }
  return out;
}

/** The first JSON object in a model reply (tolerates a ```json fence or text around it). Pure. */
export function extractJsonObject(text: string): unknown {
  const s = String(text || "");
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const body = fence ? fence[1] : s;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) { const chunk = body.slice(start, i + 1); try { return JSON.parse(fixJsonBackslashes(chunk)); } catch { try { return JSON.parse(chunk); } catch { return null; } } }
  }
  return null;
}

/** When the reply isn't a clean JSON object — cut off mid-way (token limit), a trailing comma, or plain prose — pull out what
 *  the model did say rather than failing the turn: the "speech" sentences if they're there, else the prose itself. Pure. */
export function salvageTurn(text: string, opts: { prose?: boolean } = {}): unknown {
  const s = fixJsonBackslashes(String(text || "").replace(/```(?:json)?/gi, "").trim());
  if (!s) return null;
  try { const t = JSON.parse(s.replace(/,\s*([}\]])/g, "$1")); if (t && typeof t === "object") return t; } catch { /* fall through */ }
  const m = /"speech"\s*:\s*\[((?:\s*"(?:\\.|[^"\\])*"\s*,?)+)/.exec(s);
  if (m) {
    const speech = [...m[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((x) => { try { return JSON.parse(`"${x[1]}"`); } catch { return x[1]; } });
    const move = /"move"\s*:\s*"([a-z_]+)"/i.exec(s)?.[1];
    return { speech, ...(move ? { move } : {}) };
  }
  const one = /"speech"\s*:\s*"((?:\\.|[^"\\])*)/.exec(s);
  if (one) return { speech: one[1].replace(/\\"/g, '"') };
  if (opts.prose && !s.includes("{") && s.split(/\s+/).length >= 3) return { speech: s };
  return null;
}
