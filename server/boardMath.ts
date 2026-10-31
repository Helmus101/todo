// A numeric check for the maths the board writer is about to put on the paper. The writer is a model, and a model
// "recomputing" a student's step in its head still lets a wrong line through ($\sqrt{72/56} = \sqrt{9/14}$ went up as
// if it were right). This reads a LaTeX line, evaluates every side of its equalities when they are plain numbers, and
// says the line is wrong only when two sides both evaluate and disagree. Anything it cannot read (letters, units,
// percent signs, inequalities, mixed numbers) is "unverified", never "wrong": a false alarm would delete a good line.
import { equivalent, toExprSource, varsIn } from "../shared/mathEquiv.ts";

type Tok = { t: "num"; v: number } | { t: "op"; v: string } | { t: "cmd"; v: string } | { t: "lb" } | { t: "rb" } | { t: "lp" } | { t: "rp" };

const UNREADABLE = /\\(?:text|mathrm|mathbf|operatorname|le|ge|leq|geq|neq|ne|approx|sim|lt|gt|sum|int|lim|infty|log|ln|sin|cos|tan|cdots|ldots|dots|vec|hat|bar|overline|binom|%)|[<>≤≥≠≈%a-zA-Z]/;
const SIGN = /\\pm|\\mp|±|∓/g;

function tokenize(src: string): { toks: Tok[]; pm: boolean } | null {
  let s = src.replace(/\\left|\\right|\\displaystyle|\\,|\\;|\\:|\\!|\\ /g, "").replace(/\\dfrac|\\tfrac/g, "\\frac").replace(/\\times|\\cdot|·|×/g, "*").replace(/\\div|÷/g, "/").replace(/−|–/g, "-");
  const pm = /\\pm|\\mp|±|∓/.test(s);
  s = s.replace(SIGN, "");
  // Commands we evaluate are removed before the "any letter means unreadable" test.
  const probe = s.replace(/\\frac|\\sqrt|\\pi/g, "");
  if (UNREADABLE.test(probe)) return null;
  if (/\d,\d/.test(s) || /\d\s+\d/.test(s)) return null; // decimal comma / thousands grouping: ambiguous
  const toks: Tok[] = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { const m = /^\d*\.?\d+|^\d+\.?/.exec(s.slice(i)); if (!m) return null; toks.push({ t: "num", v: parseFloat(m[0]) }); i += m[0].length; continue; }
    if (c === "\\") { const m = /^\\(frac|sqrt|pi)/.exec(s.slice(i)); if (!m) return null; toks.push({ t: "cmd", v: m[1] }); i += m[0].length; continue; }
    if ("+-*/^".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
    if (c === "{") { toks.push({ t: "lb" }); i++; continue; }
    if (c === "}") { toks.push({ t: "rb" }); i++; continue; }
    if (c === "(") { toks.push({ t: "lp" }); i++; continue; }
    if (c === ")") { toks.push({ t: "rp" }); i++; continue; }
    if (c === "[") { i++; continue; } // \sqrt[3]{x}: the index is read as a number group below; brackets are dropped
    if (c === "]") { toks.push({ t: "rb" }); i++; continue; }
    return null;
  }
  return { toks, pm };
}

class Fail extends Error {}

function evalTokens(toks: Tok[]): number | null {
  let p = 0;
  const peek = () => toks[p];
  const startsFactor = (t: Tok | undefined) => !!t && (t.t === "num" || t.t === "lp" || t.t === "lb" || (t.t === "cmd"));
  const group = (): number => {
    const t = toks[p];
    if (t?.t === "lb") { p++; const v = expr(); if (toks[p]?.t !== "rb") throw new Fail(); p++; return v; }
    return atom();
  };
  const atom = (): number => {
    const t = toks[p];
    if (!t) throw new Fail();
    if (t.t === "num") {
      p++;
      // A number straight before \frac is a mixed number (2\frac{1}{2}) or a product: ambiguous, so unverified.
      if (toks[p]?.t === "cmd" && (toks[p] as any).v === "frac") throw new Fail();
      return t.v;
    }
    if (t.t === "lp") { p++; const v = expr(); if (toks[p]?.t !== "rp") throw new Fail(); p++; return v; }
    if (t.t === "lb") return group();
    if (t.t === "cmd") {
      p++;
      if (t.v === "pi") return Math.PI;
      if (t.v === "frac") { const a = group(); const b = group(); if (b === 0) throw new Fail(); return a / b; }
      if (t.v === "sqrt") {
        let n = 2;
        if (toks[p]?.t === "num" && toks[p + 1]?.t === "rb") { n = (toks[p] as any).v; p += 2; }
        const a = group(); if (a < 0 || n === 0) throw new Fail();
        return Math.pow(a, 1 / n);
      }
    }
    throw new Fail();
  };
  const power = (): number => {
    const base = atom();
    if (peek()?.t === "op" && (peek() as any).v === "^") { p++; const e = peek()?.t === "lb" ? group() : atom(); return Math.pow(base, e); }
    return base;
  };
  const unary = (): number => {
    const t = peek();
    if (t?.t === "op" && (t as any).v === "-") { p++; return -unary(); }
    if (t?.t === "op" && (t as any).v === "+") { p++; return unary(); }
    return power();
  };
  const term = (): number => {
    let v = unary();
    for (;;) {
      const t = peek();
      if (t?.t === "op" && ((t as any).v === "*" || (t as any).v === "/")) { p++; const r = unary(); if ((t as any).v === "/" && r === 0) throw new Fail(); v = (t as any).v === "*" ? v * r : v / r; }
      else if (startsFactor(t)) { v *= power(); } // implicit multiplication: 2\sqrt{3}, 3(x+1)
      else return v;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      const t = peek();
      if (t?.t === "op" && ((t as any).v === "+" || (t as any).v === "-")) { p++; const r = term(); v = (t as any).v === "+" ? v + r : v - r; }
      else return v;
    }
  };
  try {
    const v = expr();
    if (p !== toks.length || !Number.isFinite(v)) return null;
    return v;
  } catch (e) {
    if (e instanceof Fail) return null;
    throw e;
  }
}

/** A side of an equality as a number (magnitude when it carries ±), or null when it is not plain numeric maths. */
function sideValue(side: string): { v: number; literalDecimals: number | null } | null {
  const tk = tokenize(side);
  if (!tk || !tk.toks.length) return null;
  const v = evalTokens(tk.toks);
  if (v == null) return null;
  const lit = /^\s*[+-]?\s*(\d+)\.(\d+)\s*$/.exec(side.replace(SIGN, ""));
  return { v: tk.pm ? Math.abs(v) : v, literalDecimals: lit ? lit[2].length : null };
}

/** True when a line asserts an equality between numeric or algebraic sides that is false (e.g. $\sqrt{\frac{72}{56}} = \sqrt{\frac{9}{14}}$
 *  or $\log_4 x = \frac{\log_2 4}{\log_2 x} = 2\log_2 x$). Unreadable lines and non-equalities are never "wrong". Exported for tests. */
export function boardLineIsWrong(text: string, kind?: string): boolean {
  const t = String(text || "").replace(/\$/g, " ").replace(/\\\\/g, "\\");
  if (!/=/.test(t) || /[<>≤≥≠≈]|\\(?:le|ge|leq|geq|neq|ne|approx)\b/.test(t)) return false;
  const sides = t.split("=").map((x) => x.trim());
  if (sides.length < 2) return false;
  const vals = sides.map(sideValue);
  for (let i = 0; i + 1 < vals.length; i++) {
    const a = vals[i], b = vals[i + 1];
    if (a && b) {
      // A rounded decimal ("= 0.33") may differ from the exact value by half its last digit.
      const rounded = [a.literalDecimals, b.literalDecimals].filter((d): d is number => d != null);
      const tol = rounded.length ? 0.5 * Math.pow(10, -Math.min(...rounded)) * 1.001 : 1e-9 * Math.max(1, Math.abs(a.v), Math.abs(b.v));
      if (Math.abs(a.v - b.v) > tol) return true;
    } else if (!a && !b && (sides.length >= 3 || kind === "formula")) {
      // Algebraic chained equality A = B = C (or formula A = B): both sides are expressions. If both have the same
      // set of free variables and equivalent returns "incorrect", the asserted identity is mathematically false.
      const sA = toExprSource(sides[i]);
      const sB = toExprSource(sides[i + 1]);
      if (sA && sB) {
        const vA = varsIn(sA).sort();
        const vB = varsIn(sB).sort();
        if (vA.length > 0 && vA.length === vB.length && vA.every((v, idx) => v === vB[idx])) {
          if (equivalent(sides[i], sides[i + 1]) === "incorrect") return true;
        }
      }
    }
  }
  return false;
}

// ---- Units the student has not said ---------------------------------------------------------------------------------
// When the tutor's open question is about the unit ("what units would you include?"), a result line that already
// carries it ("833 N") has answered the question on the board before the student did. This removes a trailing unit from
// a line, but only when the student has not said it themselves. Pure; exported for tests.
const UNIT_NAMES: Record<string, RegExp> = {
  N: /newtons?/i, J: /joules?/i, W: /watts?/i, Pa: /pascals?/i, Hz: /hertz/i, V: /volts?/i, kg: /kilograms?|kilos?/i,
  mol: /moles?/i, eV: /electron.?volts?/i, "m/s": /meters? per second|metres? per second|m\/s/i,
};
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");

export function stripUnaskedUnit(text: string, studentText: string): string {
  const said = String(studentText || "");
  const re = /(\d)((?:\s|\\,|\;|\\:|\\ |~)*)(?:\\text\{\s*([^}]+?)\s*\}|\\mathrm\{\s*([^}]+?)\s*\}|\b(N|J|W|Pa|Hz|V|kg|mol|eV|m\/s)\b)(?=\s*(?:\$|$|[.,;)]))/g;
  return String(text || "").replace(re, (m, digit: string, _gap: string, t1?: string, t2?: string, bare?: string) => {
    const u = String(t1 || t2 || bare || "").trim();
    if (!u) return m;
    const sym = new RegExp(`(^|[^A-Za-z])${escapeRe(u)}($|[^A-Za-z])`);
    const name = UNIT_NAMES[u];
    if (sym.test(said) || (name && name.test(said))) return m; // the student said the unit: it is theirs to keep
    return digit;
  });
}
