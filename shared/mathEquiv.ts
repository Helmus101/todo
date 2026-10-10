// Deterministic "is this step right?" for algebra, so the tutor's verdict on a student's line never rests on
// the language model's guess. Both sides are turned into mathExpr source (LaTeX or plain, "°" honoured),
// compiled with the same eval-free compiler the graphs use, and compared at several random points for the
// free variables. Anything that doesn't compile is "unknown" — never "incorrect": a parse gap must not tell a
// student they're wrong. Pure; shared by server (grading, prompt verdicts) and tests.
import { compileExpr } from "./mathExpr.ts";

export type Verdict = "correct" | "incorrect" | "unknown";

const FN = "arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|cot|sec|csc|ln|log|exp|sqrt";
const ARC: Record<string, string> = { arcsin: "asin", arccos: "acos", arctan: "atan" };

/** Read one balanced {…} group starting at s[i] === "{"; returns its inner text and the index after it. */
function group(s: string, i: number): [string, number] | null {
  if (s[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}" && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return null;
}

/** Rewrite \frac{a}{b} / \sqrt{a} (any nesting) into bracketed infix. */
function unfracs(s: string): string {
  let out = "";
  for (let i = 0; i < s.length;) {
    const m = /^\\[dtc]?frac\s*/.exec(s.slice(i));
    if (m) {
      const j = i + m[0].length;
      // \tfrac12 shorthand
      const short = /^(\d)(\d)/.exec(s.slice(j));
      if (s[j] !== "{" && short) { out += `(${short[1]}/${short[2]})`; i = j + 2; continue; }
      const a = group(s, j);
      const b = a && group(s, a[1]);
      if (a && b) { out += `((${unfracs(a[0])})/(${unfracs(b[0])}))`; i = b[1]; continue; }
    }
    const r = /^\\sqrt\s*/.exec(s.slice(i));
    if (r) {
      const a = group(s, i + r[0].length);
      if (a) { out += `sqrt(${unfracs(a[0])})`; i = a[1]; continue; }
    }
    out += s[i++];
  }
  return out;
}

/** LaTeX or plain student input → mathExpr source. Angles marked with ° / ^\circ become radians. A leading
 *  "b =" (the variable the gap asks for) is dropped. Exported for tests. */
export function toExprSource(input: string, target?: string): string {
  let s = String(input || "").trim().replace(/^\$+|\$+$/g, "").replace(/^\\\(|\\\)$/g, "");
  if (target) s = s.replace(new RegExp(`^\\s*${target}\\s*=`), "");
  else s = s.replace(/^\s*[A-Za-z]\s*=(?!=)/, "");
  s = s.replace(/\\(?:left|right|displaystyle|textstyle|,|;|!|:|\s)/g, " ");
  s = s.replace(/\^\s*\{\s*\\circ\s*\}|\^\s*\\circ|\\circ|°/g, "°");
  s = unfracs(s);
  s = s.replace(/\\cdot|\\times|×|·/g, "*").replace(/\\div|÷/g, "/").replace(/\\pi\b/g, "pi").replace(/−/g, "-");
  s = s.replace(new RegExp(`\\\\(${FN})\\b`, "g"), "$1").replace(/\b(arcsin|arccos|arctan)\b/g, (f) => ARC[f]);
  s = s.replace(/\\[a-zA-Z]+/g, " ").replace(/[{}]/g, (c) => (c === "{" ? "(" : ")"));
  // A trig function written without brackets ("tan 25°", "sin x") takes the next number/variable as its argument.
  s = s.replace(new RegExp(`\\b(${FN})\\s+(\\d+(?:\\.\\d+)?°?|[A-Za-z]\\b)`, "g"), "$1($2)");
  s = s.replace(/(\d+(?:\.\d+)?)\s*°/g, "($1*pi/180)").replace(/\)\s*°/g, ")*pi/180").replace(/°/g, "");
  // A plain-text "25%" means a quarter, as a student answer.
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, "($1/100)");
  return s.replace(/\s+/g, " ").trim();
}

function varsIn(src: string): string[] {
  const ids = src.match(/[A-Za-z_][A-Za-z_0-9]*/g) || [];
  const known = new Set([...FN.split("|"), "pi", "e", "asin", "acos", "atan", "abs", "floor", "ceil", "round", "sign", "log10"]);
  // Only single letters are variables: a multi-letter word ("the angle") then fails to compile → "unknown".
  return [...new Set(ids.filter((v) => v.length === 1 && !known.has(v.toLowerCase())))];
}

/** Are `given` and `expected` the same expression? Compared at 6 random points in each free variable (both
 *  sides' variables, so a stray letter makes them differ), relative tolerance 1e-6. `target` is the letter
 *  the gap asks for ("b"), dropped from a leading "b =". */
export function equivalent(given: string, expected: string, target?: string): Verdict {
  const a = toExprSource(given, target);
  const b = toExprSource(expected, target);
  if (!a || !b) return "unknown";
  const vars = [...new Set([...varsIn(a), ...varsIn(b)])];
  const fa = compileExpr(a, vars);
  const fb = compileExpr(b, vars);
  if ("error" in fa || "error" in fb) return "unknown";
  let compared = 0;
  // Deterministic pseudo-random points (no Math.random — the same inputs always get the same verdict).
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 12 && compared < 6; k++) {
    const point: Record<string, number> = {};
    for (const v of vars) point[v] = 0.5 + rnd() * 2.5;
    const x = fa.fn(point), y = fb.fn(point);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    compared++;
    if (Math.abs(x - y) > 1e-6 * Math.max(1, Math.abs(x), Math.abs(y))) return "incorrect";
  }
  return compared >= 3 ? "correct" : "unknown";
}

/** Can this expected answer be checked at all? A gap whose key doesn't compile can't be graded by code. */
export function checkable(expected: string, target?: string): boolean {
  const src = toExprSource(expected, target);
  return !!src && !("error" in compileExpr(src, varsIn(src)));
}

/** The letter a gap asks for, from its text ("b = ?" → "b"), if any. */
export function gapTarget(text: string): string | undefined {
  return /(?:^|[\s$])([A-Za-z])\s*=\s*\??\s*\$?\s*$/.exec(String(text || "").trim())?.[1]
    ?? /(?:^|[\s$(])([A-Za-z])\s*=\s*\?/.exec(String(text || ""))?.[1];
}

/** The deterministic verdict on a student's chat step against the newest OPEN gap ("b = ?" with an answer
 *  key): the message's last "… = expr" (or the whole message when it's a bare expression) is compared by
 *  numeric equivalence. Undefined when there's no open gap, or the step can't be read as maths. */
export function verifyStepAgainstGap(message: string, board: { kind?: string; text: string; expectedAnswer?: string; status?: string }[]): { gap: string; given: string; verdict: "correct" | "incorrect" } | undefined {
  const gap = [...board].reverse().find((e) => e.kind === "gap" && e.expectedAnswer && e.status !== "correct");
  if (!gap?.expectedAnswer) return undefined;
  const target = gapTarget(gap.text);
  const m = String(message || "").replace(/\$/g, "").trim();
  const candidates = [m, ...(m.match(/[^,;.\n]*=[^,;\n]+/g) || []).map((x) => x.trim()), m.split("=").pop()?.trim() || ""].filter(Boolean);
  for (const c of candidates) {
    const v = equivalent(c, gap.expectedAnswer, target);
    if (v !== "unknown") return { gap: gap.text.slice(0, 160), given: c.slice(0, 160), verdict: v };
  }
  return undefined;
}
