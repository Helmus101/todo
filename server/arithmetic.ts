/**
 * Deterministic arithmetic evaluation and equality-claim extraction — the code-level ground truth
 * underneath the tutor's "never wrong about computation" guarantee (the CoVe/CRITIC posture: the
 * verifier must be an INDEPENDENT oracle, not the model re-reading its own draft — Huang et al.,
 * "LLMs Cannot Self-Correct Reasoning Yet", ICLR 2024).
 *
 * PURE and dependency-free: imported by server/claude.ts (the CREATE_CALC tool + the post-reply
 * verification pass) and usable by the client (the "double-check this" affordance) — no node builtins,
 * no DOM, no imports at all, so it lands in either bundle unchanged.
 *
 * THIS IS NOT A GENERAL CALCULATOR, on purpose. One shared parse for both the tool and the verifier
 * means the model can't exploit a difference between them, and every behavior added here is a behavior
 * both callers get for free. Scope: integers and decimals, + - × ÷ and parentheses, unary minus,
 * EN form (1,234.5) and FR form (1 234,5), and the unicode operators the tutor actually writes
 * (× · ÷ − –, plus a bare "x" between digits). Exponents are deliberately OUT: ^ parsing is where
 * convention ambiguity creeps in, and a verifier that can silently disagree about precedence is worse
 * than none — an expression with anything outside the subset evaluates to null and is SKIPPED by every
 * caller, never guessed at.
 */

/** One equality the text asserts: both sides exactly as written, plus their parsed values. */
export interface ArithmeticClaim {
  /** The full matched string, verbatim (e.g. "3 × 47 = 141") — used to show the model its own claim. */
  raw: string;
  lhs: string;
  rhs: string;
  /** null when that side isn't in the supported arithmetic subset — never a best-effort guess. */
  left: number | null;
  right: number | null;
  /** Both sides parsed AND they disagree beyond float tolerance → a genuine arithmetic error. */
  mismatch: boolean;
}

/** Relative tolerance for float agreement: relative 1e-9 plus an absolute floor for values near zero. */
const EPSILON = (x: number) => Math.abs(x) * 1e-9 + 1e-9;

// A number as the tutor writes it: optional FR thin-space/nbsp grouping between digits ("1 234"),
// EN comma grouping ("1,234"), either decimal separator, and an optional unit suffix the tutor
// appends to results ("% € $ km h min m s L g t °C"…). Unit-bearing numbers are accepted where a
// RESULT is expected, but units never enter expressions (they'd need dimensional analysis to verify).
// ALTERNATION ORDER MATTERS in JS regex — at the same position the FIRST alternative wins even when
// a later one is LONGER — so longest-first is load-bearing, not stylistic: with a bare `\d+` before
// the comma-decimal form, "2,5 + 1 = 3,5" matched LHS as just "2" and the comma floated free into
// the separator whitespace, producing the phantom claim "5 + 1 = 3,5".
const NUM_TOK =
  "\\d{1,3}(?:[\\u00A0\\u202F ]\\d{3})+(?:[.,]\\d+)?" + // 1 234 / 1 234,5 / 1,234 / 1,234.5
  "|\\d+[.,]\\d+" +                                     // 2,5 / 3.5 (either decimal separator)
  "|\\d+";                                              // 42
const UNIT = "(?:\\s?(?:%|°[CF]?|€|\\$|£|kg|km|cm|mm|h|min|\\bL\\b|\\bg\\b|\\bt\\b|\\bm\\b|\\bs\\b))?";
const NUM = `(?:${NUM_TOK})${UNIT}`;

// Just parseable-arithmetic shapes — hasArithmetic's cheap pre-filter. NO leading \b: a number that
// starts with a separator ("2,5") after a non-word char (", " / ". ") has no word boundary there,
// and the LHS character classes are already strict enough on their own.
const EXPR = new RegExp(`(?:[~≈]\\s*|\\b(?:environ|about)\\s*)?(?:${NUM_TOK})(?:\\s*[+\\-−–×x*·÷/]\\s*(?:${NUM_TOK}))+`, "g");

// Full asserted equalities: arithmetic LHS, a separator (also the FR "3 + 3 donne 6" forms), a result.
// No leading \b (same reason as EXPR). The trailing lookahead rejects a match whose RHS is actually
// the START of a longer expression ("x = 34 + 1" must not verify as "34 = 1") — those are skipped,
// not misread; findArithmeticClaims additionally skips matches that begin mid-number.
const EQUALITY = new RegExp(
  `((?:${NUM_TOK})(?:\\s*[+\\-−–×x*·÷/]\\s*(?:${NUM_TOK}))+)` + // 1: LHS expression — the leading
  // NUM_TOK MUST be wrapped in (?:…) or its internal | alternation escapes the capture group and
  // only the bare-\d+ branch keeps the operator suffix (the "234 × 2 = 2 468" mis-anchor bug).
  `\\s*(=|donne|fait|vaut)\\s*` +                           // 2: separator
  `(${NUM})` +                                              // 3: claimed result
  `(?![\\s]*(?:[+\\-−–×x*·÷/=]|\\d))`,
  "g",
);

/**
 * Normalize a written number (EN or FR convention, unit suffix, thin/nbsp grouping) to a JS number.
 * Returns null for anything not unambiguously a number — malformed grouping ("12 34") resolves to
 * nothing at all, because a verifier that guesses is worthless.
 */
export function parseNumber(raw: string): number | null {
  let s = raw.trim()
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/^(?:€|\$|£)/, "")
    .replace(/(?:%|°[CF]?|kg|km|cm|mm|€|\$|£|h|min|L|g|t|m|s)$/i, "")
    .trim();
  if (!s) return null;
  // Scientific form "1,5×10^3" / "2 × 10 -6" / "3e5" — FR tutoring does write these; parse the
  // mantissa with the same grouped-number rules, then shift. (The EXPRESSION evaluator does NOT
  // accept "×10^" — see the scope note above — so this only ever fires on a standalone result.)
  const sci = s.match(/^([\d.,]+(?: [\d.,]+)*)\s*(?:[eE]|×\s*10\s*\^?)\s*(-?\d+)$/);
  if (sci) {
    const mantissa = parseGrouped(sci[1].replace(/ /g, ""));
    return mantissa == null ? null : mantissa * Math.pow(10, parseInt(sci[2], 10));
  }
  return parseGrouped(s);
}

function parseGrouped(input: string): number | null {
  let s = input.trim();
  if (!s) return null;
  // FR thin-space grouping is unambiguous ONLY in strict triplets from the left ("1 234 567");
  // anything else spaced ("12 34") is malformed, and a verifier that guesses is worthless.
  if (/\d \d/.test(s)) {
    if (!/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(s)) return null;
    s = s.replace(/ /g, "");
  }
  const hasComma = s.includes(","), hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Both separators present: the LAST one is the decimal separator, the other is grouping.
    const dec = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const grp = dec === "," ? "." : ",";
    return tryNumber(s.split(grp).join("").replace(dec, "."));
  }
  if (hasComma) {
    // Comma only: strictly-triplet "1,234" (with no other grouping signal) reads as EN grouping;
    // anything else ("3,5") reads as a FR decimal.
    const triplet = /^\d{1,3}(,\d{3})+$/.test(s);
    return tryNumber(triplet ? s.split(",").join("") : s.replace(",", "."));
  }
  if (hasDot) {
    // Dot only: strictly-triplet "1.234" reads as EN grouping, otherwise a decimal ("3.5").
    const triplet = /^\d{1,3}(\.\d{3})+$/.test(s);
    return tryNumber(triplet ? s.split(".").join("") : s);
  }
  return tryNumber(s);
}

function tryNumber(s: string): number | null {
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// ---------- tokenizer + shunting-yard evaluator (no eval, ever) ----------

type Tok = { t: "num"; v: number } | { t: "op"; v: "+" | "-" | "*" | "/" } | { t: "lp" } | { t: "rp" };

const PREC: Record<"+" | "-" | "*" | "/", number> = { "+": 1, "-": 1, "*": 2, "/": 2 };

function normalizeOps(s: string): string {
  // × · * → multiply; ÷ → divide; − (U+2212) – (en dash) → minus. A standalone letter "x" BETWEEN
  // digits ("3 x 4") is tutor handwriting for × — handled in tokenize (prev number, next digit),
  // NOT here, so no regex lookbehind (lookbehind breaks older Safari, and the client imports this).
  // An "x" anywhere else fails tokenizing below rather than being silently reinterpreted.
  return s.replace(/×|·/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-");
}

function tokenize(input: string): Tok[] | null {
  const s = normalizeOps(input).replace(/[\u00A0\u202F]/g, " ");
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " ") { i++; continue; }
    if (c === "+") { toks.push({ t: "op", v: "+" }); i++; continue; }
    if (c === "-") {
      const prev = toks[toks.length - 1];
      // Unary minus: at the start, or right after an operator or open paren — fold into the number.
      if (!prev || prev.t === "op" || prev.t === "lp") {
        const numMatch = new RegExp(`^(-)\\s*(${NUM_TOK})`).exec(s.slice(i));
        if (!numMatch) return null;
        const v = parseNumber(numMatch[2]);
        if (v == null) return null;
        toks.push({ t: "num", v: -v });
        i += numMatch[0].length;
        continue;
      }
      toks.push({ t: "op", v: "-" });
      i++;
      continue;
    }
    if (c === "*" || c === "/") { toks.push({ t: "op", v: c as "*" | "/" }); i++; continue; }
    if (c === "x" || c === "X") {
      // "3 x 4" — handwriting for ×. Only valid sandwiched between two numbers; anything else fails.
      const prev = toks[toks.length - 1];
      if (prev?.t === "num" && /^\s*\d/.test(s.slice(i + 1))) { toks.push({ t: "op", v: "*" }); i++; continue; }
      return null;
    }
    if (c === "(") { toks.push({ t: "lp" }); i++; continue; }
    if (c === ")") { toks.push({ t: "rp" }); i++; continue; }
    const numMatch = new RegExp(`^(?:${NUM_TOK})`).exec(s.slice(i));
    if (numMatch) {
      const v = parseNumber(numMatch[0]);
      if (v == null) return null;
      toks.push({ t: "num", v });
      i += numMatch[0].length;
      continue;
    }
    return null; // any unknown character fails the WHOLE expression — deliberately, not leniently
  }
  return toks;
}

/** Evaluate an arithmetic expression to a number, or null when ANY part isn't in the supported
 *  subset. Never a best-effort partial result: callers use this to accuse or clear a draft of
 *  errors, so "I couldn't parse that" and "that's wrong" must stay two different answers. */
export function evaluateArithmetic(expr: string): number | null {
  const toks = tokenize(expr);
  if (!toks || !toks.length) return null;
  // shunting-yard → RPN (unary minus is already folded into its number by the tokenizer)
  const out: Tok[] = [];
  const ops: Tok[] = [];
  let prev: Tok | null = null;
  for (const tok of toks) {
    if (tok.t === "num") out.push(tok);
    else if (tok.t === "op") {
      if (prev && prev.t === "op") return null; // "3 + * 4" — an operator where a number was required
      while (ops.length && ops[ops.length - 1].t === "op" && PREC[(ops[ops.length - 1] as { v: "+" | "-" | "*" | "/" }).v] >= PREC[tok.v]) out.push(ops.pop()!);
      ops.push(tok);
    } else if (tok.t === "lp") ops.push(tok);
    else {
      while (ops.length && ops[ops.length - 1].t !== "lp") out.push(ops.pop()!);
      if (!ops.length) return null; // unbalanced ")"
      ops.pop();
    }
    prev = tok;
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op.t === "lp") return null; // unbalanced "("
    out.push(op);
  }
  const st: number[] = [];
  for (const tok of out) {
    if (tok.t === "num") { st.push(tok.v); continue; }
    if (tok.t !== "op") return null; // lp/rp never reach RPN (consumed by shunting) — defensive
    if (st.length < 2) return null; // malformed RPN (operator-first input, etc.)
    const b = st.pop()!, a = st.pop()!;
    st.push(tok.v === "+" ? a + b : tok.v === "-" ? a - b : tok.v === "*" ? a * b : a / b);
  }
  if (st.length !== 1 || !Number.isFinite(st[0])) return null; // "1/0" and friends → unverified, not zero
  return st[0];
}

/**
 * Find every arithmetic equality a reply asserts ("12 × 3 = 36", "2,5 + 1 = 3,5", "3 + 3 donne 6").
 * Returns them in text order, duplicates collapsed. `mismatch` is true ONLY when both sides parse
 * and disagree — a claim with null on either side is an UNVERIFIED claim, not a wrong one. Claims
 * the evaluator can't represent are skipped entirely (the percent form "50% de 80 = 45" forms no
 * claim rather than being misread as "50 + 80"; algebra "2x + 1 = 5" likewise). This is exactly
 * what the post-reply verifier and the CREATE_CALC tool share.
 */
export function findArithmeticClaims(text: string): ArithmeticClaim[] {
  const claims: ArithmeticClaim[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(EQUALITY)) {
    // Skip a match that begins mid-number (the regex can legally start inside a longer number when
    // the true start failed for an unrelated reason — e.g. the tail of "1,234" or "x = 34"): a
    // digit/separator immediately before the match means this isn't where the number really starts.
    const idx = m.index ?? 0;
    if (idx > 0 && /[\d.,]/.test(text[idx - 1])) continue;
    const lhs = m[1].trim(), rhs = m[3].trim();
    if (!lhs || !rhs) continue;
    const key = `${lhs}=${rhs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const left = evaluateArithmetic(lhs);
    const right = parseNumber(rhs);
    claims.push({
      raw: m[0].trim(),
      lhs,
      rhs,
      left,
      right,
      mismatch: left != null && right != null && Math.abs(left - right) > EPSILON(Math.max(Math.abs(left), Math.abs(right))),
    });
  }
  return claims;
}

/** Cheap pre-filter for callers deciding whether a verification pass is worth a model round at all. */
export function hasArithmetic(text: string): boolean {
  EXPR.lastIndex = 0;
  return EXPR.test(text);
}
