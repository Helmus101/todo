// THE TUTOR'S TURN, AS DATA. One model call returns {speech, board}: what Otto says (one sentence per item) and what he
// writes or draws while saying it (each op carries `cue`, the sentence it belongs to). apply.ts builds the board entries.

import { hideToolLeaks } from "./toolLeak.ts";

export const STEP_KINDS = ["given", "formula", "definition", "result", "summary", "strategy", "insight", "note"] as const;
export const MARK_STYLES = ["circle", "underline", "box", "arrow", "cross", "tick"] as const;
export const MARK_TONES = ["error", "hint", "good", "focus"] as const;
export const SCENES = ["graph", "geometry", "incline", "trig", "flow", "table", "source", "widget", "svg", "numberline", "balance"] as const;
export const BOARD_OPS = ["topic", "step", "mark", "draw"] as const;

export type MarkStyle = (typeof MARK_STYLES)[number];
export type Scene = (typeof SCENES)[number];

/** One board change. Flat on purpose (one `op` plus optional fields): every provider's JSON mode handles it. */
export interface BoardOp {
  op: (typeof BOARD_OPS)[number];
  /** Index of the `speech` sentence this change belongs to — the board animates when that sentence is spoken. */
  cue: number;
  /** topic: the header. step: the line (maths in $…$). draw: the caption. */
  text?: string;
  kind?: (typeof STEP_KINDS)[number];
  /** One plain sentence: what this line does and why. */
  why?: string;
  /** mark: the board line it points at ("#4"). */
  target?: string;
  style?: MarkStyle;
  tone?: (typeof MARK_TONES)[number];
  /** mark: a short note beside the line (≤ 15 words, never the fix). */
  note?: string;
  /** mark: the exact bit of the line to circle/underline. */
  part?: string;
  scene?: Scene;
  spec?: Record<string, unknown>;
}

export interface TurnOutput {
  /** The reply, one sentence per item, in order. */
  speech: string[];
  board: BoardOp[];
}

const str = (x: unknown, cap: number): string => hideToolLeaks(String(x ?? "")).replace(/\s+/g, " ").trim().slice(0, cap);
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
  const op = optPick(BOARD_OPS, o.op ?? o.type);
  if (!op) return null;
  const cueRaw = Number(o.cue);
  const out: BoardOp = { op, cue: Number.isFinite(cueRaw) ? Math.max(0, Math.min(Math.max(0, nSpeech - 1), Math.round(cueRaw))) : 0 };
  const text = str(o.text ?? o.latex ?? o.caption, 600);
  if (text) out.text = text;
  const kind = optPick(STEP_KINDS, o.kind);
  if (kind) out.kind = kind;
  const why = str(o.why, 220);
  if (why) out.why = why;
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
  return out;
}

/** Whatever JSON the model produced → a valid TurnOutput, or null when there is no usable speech. Lenient about shape
 *  (a string instead of an array, a synonym field name). Pure. */
export function normalizeTurn(raw: unknown): TurnOutput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as any;
  const speechRaw = Array.isArray(r.speech) ? r.speech.map((s: unknown) => str(s, 600)).filter(Boolean) : sentences(str(r.speech ?? r.reply ?? r.say, 2400));
  const speech = speechRaw.flatMap((s: string) => sentences(s)).slice(0, 8);
  if (!speech.length) return null;
  const ops = Array.isArray(r.board) ? r.board : Array.isArray(r.board_actions) ? r.board_actions : [];
  return { speech, board: ops.map((o: unknown) => normalizeOp(o, speech.length)).filter((o: BoardOp | null): o is BoardOp => !!o).slice(0, 8) };
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
