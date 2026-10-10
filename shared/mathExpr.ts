// A tiny, dependency-free, EVAL-FREE math expression compiler — the one thing a tutor graph needs. Used by the
// server to validate what the model asks to plot, and by the client to draw it, so both agree on exactly what
// an expression means. Grammar: numbers, variables (x and slider params), + - * / ^ (right-assoc, ** too),
// unary minus, parentheses, implicit multiplication ("2x", "3(x+1)", "x sin(x)"), constants pi/e, and a fixed
// whitelist of one-argument functions. Anything else is a compile error — never executed as code.

type Node =
  | { t: "num"; v: number }
  | { t: "var"; n: string }
  | { t: "neg"; a: Node }
  | { t: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Node; b: Node }
  | { t: "fn"; f: string; a: Node };

const FUNCS: Record<string, (x: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  cot: (x) => 1 / Math.tan(x), sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x),
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: Math.log10, log10: Math.log10, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Tok = { k: "num"; v: number } | { k: "id"; v: string } | { k: "op"; v: string };

function tokenize(src: string): Tok[] | string {
  const out: Tok[] = [];
  const s = src.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/π/g, "pi").replace(/²/g, "^2").replace(/³/g, "^3").replace(/\*\*/g, "^");
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
      if (!m) return `bad number near "${s.slice(i, i + 5)}"`;
      // "2e" must stay "2 * e": only treat the exponent form when digits actually follow.
      out.push({ k: "num", v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (/[a-z_]/i.test(c)) { const m = /^[a-z_][a-z_0-9]*/i.exec(s.slice(i))!; out.push({ k: "id", v: m[0].toLowerCase() }); i += m[0].length; continue; }
    if ("+-*/^(),".includes(c)) { out.push({ k: "op", v: c }); i++; continue; }
    return `unsupported character "${c}"`;
  }
  return out;
}

export function parseExpr(src: string, vars: string[]): { ast: Node } | { error: string } {
  if (!src.trim()) return { error: "empty expression" };
  if (src.length > 200) return { error: "expression too long" };
  const tk = tokenize(src);
  if (typeof tk === "string") return { error: tk };
  const toks: Tok[] = tk;
  const allowed = new Set(vars.map((v) => v.toLowerCase()));
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.k === "op" && (peek() as any).v === v;
  const fail = (m: string): never => { throw new Error(m); };
  const startsFactor = (t: Tok | undefined) => !!t && (t.k === "num" || t.k === "id" || (t.k === "op" && t.v === "("));

  function expr(): Node {
    let a = term();
    while (isOp("+") || isOp("-")) { const op = (toks[p++] as any).v as "+" | "-"; a = { t: "bin", op, a, b: term() }; }
    return a;
  }
  function term(): Node {
    let a = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) { const op = (toks[p++] as any).v as "*" | "/"; a = { t: "bin", op, a, b: unary() }; }
      else if (startsFactor(peek())) a = { t: "bin", op: "*", a, b: unary() }; // implicit multiplication
      else return a;
    }
  }
  function unary(): Node {
    if (isOp("-")) { p++; return { t: "neg", a: unary() }; }
    if (isOp("+")) { p++; return unary(); }
    return power();
  }
  function power(): Node {
    const base = atom();
    if (isOp("^")) { p++; return { t: "bin", op: "^", a: base, b: unary() }; } // right-assoc, allows 2^-x
    return base;
  }
  function atom(): Node {
    const t = toks[p++];
    if (!t) return fail("unexpected end");
    if (t.k === "num") return { t: "num", v: t.v };
    if (t.k === "op" && t.v === "(") { const e = expr(); if (!isOp(")")) fail("missing )"); p++; return e; }
    if (t.k === "id") {
      if (FUNCS[t.v] && isOp("(")) { p++; const a = expr(); if (!isOp(")")) fail("missing )"); p++; return { t: "fn", f: t.v, a }; }
      if (FUNCS[t.v]) return fail(`${t.v} needs parentheses, e.g. ${t.v}(x)`);
      if (allowed.has(t.v)) return { t: "var", n: t.v };
      if (t.v in CONSTS) return { t: "num", v: CONSTS[t.v] };
      return fail(`unknown name "${t.v}" (allowed: ${[...allowed].join(", ") || "none"}, pi, e, ${Object.keys(FUNCS).slice(0, 8).join(", ")}…)`);
    }
    return fail(`unexpected "${(t as any).v}"`);
  }
  try {
    const ast = expr();
    if (p < toks.length) return { error: `unexpected "${(toks[p] as any).v}"` };
    return { ast };
  } catch (e: any) { return { error: String(e?.message || e) }; }
}

function run(n: Node, v: Record<string, number>): number {
  switch (n.t) {
    case "num": return n.v;
    case "var": return v[n.n] ?? NaN;
    case "neg": return -run(n.a, v);
    case "fn": return FUNCS[n.f](run(n.a, v));
    case "bin": {
      const a = run(n.a, v), b = run(n.b, v);
      return n.op === "+" ? a + b : n.op === "-" ? a - b : n.op === "*" ? a * b : n.op === "/" ? a / b : Math.pow(a, b);
    }
  }
}

/** Compile to a function of the variable map. Returns NaN/±Infinity for undefined points (the plotter breaks the line there). */
export function compileExpr(src: string, vars: string[]): { fn: (v: Record<string, number>) => number } | { error: string } {
  const r = parseExpr(src, vars);
  if ("error" in r) return r;
  const ast = r.ast;
  return { fn: (v) => run(ast, v) };
}
