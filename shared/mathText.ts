// Plain-text maths → inline LaTeX, for lines the tutor wrote as plain Unicode ("sin(π/3) = √3/2, cos(π/3) = 1/2")
// instead of $…$. Splits a line into prose words and "math runs", rewrites each run into LaTeX (fractions, roots,
// greek, function names, arrows) and wraps it in $…$ so the board can typeset it with KaTeX. Pure; if a line already
// contains `$`, `\(` or a LaTeX command it is returned untouched. A run KaTeX can't parse falls back to its plain
// text at render time (client), so a bad guess never breaks a line.
const FN = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp", "lim", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh"]);

const isMathToken = (t: string): boolean => {
  const bare = t.replace(/^[(\[{]+|[)\]},.;:]+$/g, "");
  if (!bare) return /[=+\-−×·÷/^<>≤≥≈≠→⇒]/.test(t);
  // a LaTeX command token ("\sin", "\alpha", "\tfrac12") is maths by definition — without this the
  // command's letters read as prose ("tfrackx" is 7 letters) and the line prints with a raw backslash.
  if (/^\\[a-zA-Z]+/.test(bare)) return true;
  // an ordinary word (3+ letters that isn't a function name) is prose, even with a hyphen in it ("special-angle")
  for (const w of bare.match(/\p{L}{3,}/gu) || []) if (!FN.has(w.toLowerCase())) return false;
  if (FN.has(bare.toLowerCase())) return true; // "sin" / "cos" on their own: "sin A cos B"
  if (/^\p{L}$/u.test(bare)) return true; // a single-letter variable: x, A, θ
  if (/[0-9=+\-−×·÷/^<>≤≥≈≠→⇒√π∞∑∫°⁰-⁹₀-₉]|->|=>/.test(bare)) return true;
  const word = bare.match(/^[A-Za-z]+/)?.[0]?.toLowerCase() || "";
  if (FN.has(word) && /[(0-9π]/.test(bare.slice(word.length))) return true;
  return false;
};

const GREEK: [RegExp, string][] = [[/π/g, "\\pi "], [/θ/g, "\\theta "], [/α/g, "\\alpha "], [/β/g, "\\beta "], [/γ/g, "\\gamma "], [/λ/g, "\\lambda "], [/μ/g, "\\mu "], [/φ/g, "\\varphi "], [/ω/g, "\\omega "], [/Δ/g, "\\Delta "]];

/** Convert one plain-text math run to LaTeX. Exported for tests. */
export function plainMathToLatex(run: string): string {
  let s = run.trim();
  // "\ " control space (model writes "1.8\ J") — a lone backslash in math mode prints raw otherwise.
  s = s.replace(/\\\s+/g, " ");
  // unicode scripts written directly ("v²", "x₀") — wrap them so KaTeX treats them as real scripts.
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => `^{${"⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(c)}}`);
  s = s.replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (c) => `_{${"₀₁₂₃₄₅₆₇₈₉".indexOf(c)}}`);
  s = s.replace(/->|⟶|→/g, " \\to ").replace(/=>|⇒/g, " \\Rightarrow ").replace(/≤/g, "\\le ").replace(/≥/g, "\\ge ").replace(/≠/g, "\\ne ").replace(/≈/g, "\\approx ").replace(/×/g, "\\times ").replace(/·/g, "\\cdot ").replace(/÷/g, "\\div ").replace(/−/g, "-").replace(/°/g, "^\\circ ");
  for (const [re, rep] of GREEK) s = s.replace(re, rep);
  s = s.replace(/\b(arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|cot|sec|csc|log|ln|exp|lim)\b/g, "\\$1");
  // roots: √(expr) | √number | √letter
  s = s.replace(/√\(([^()]*)\)/g, "\\sqrt{$1}").replace(/√(\d+(?:\.\d+)?|[A-Za-z])/g, "\\sqrt{$1}");
  // fractions a/b where each side is a (…) group or a simple term (digits, letters, \pi, \sqrt{..}); repeat for nesting
  const atom = "(\\([^()]*\\)|\\d*\\\\sqrt\\{[^{}]*\\}|\\d*\\\\pi|\\d+(?:\\.\\d+)?[A-Za-z]?|[A-Za-z])";
  const frac = new RegExp(`${atom}\\s*\\/\\s*${atom}`, "g");
  for (let i = 0; i < 3; i++) s = s.replace(frac, (_, a: string, b: string) => `\\frac{${a.replace(/^\((.*)\)$/, "$1")}}{${b.replace(/^\((.*)\)$/, "$1")}}`);
  s = s.replace(/\^(\d+|[A-Za-z])/g, "^{$1}");
  return s.replace(/\s{2,}/g, " ").trim();
}

/** A {…} group with up to four levels of nesting. A flat `\{[^{}]*\}` stopped at the first inner brace, so a
 *  nested "\frac{h}{100 + \frac{h}{\tan 25^\circ}}" was wrapped only up to "\frac{h}" and the rest printed raw
 *  (reported live on the tower problem). */
const BRACED = (() => { let g = "\\{[^{}]*\\}"; for (let i = 0; i < 3; i++) g = `\\{(?:[^{}]|${g})*\\}`; return g; })();
const RAW_LATEX_RUN = new RegExp(`\\\\[a-zA-Z]+(?:\\s*${BRACED}|\\s*\\\\[a-zA-Z]+|\\s*[A-Za-z](?![A-Za-z])|[\\d+\\-*/().=^_,:πθμ√∞°\\s])+`, "g");

/** A bare LaTeX run the model wrote WITHOUT $…$ (reported live on the board: "x = \tfracπ3, \tfrac5π3"
 *  printed as raw commands, or as jammed plain text). Wrap such a run in $…$ so KaTeX typesets it instead.
 *  Only a run that carries a real expression after the command (operator, digit, greek, or a {group}) is
 *  touched — prose that merely mentions a command is left alone — and segments already inside $…$ / \(…\)
 *  are never re-wrapped. */
export function wrapRawLatex(line: string): string {
  if (!/\\[a-zA-Z]+/.test(line)) return line;
  const parts = line.split(/(\$[^$\n]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g);
  return parts.map((seg) => {
    if (!seg) return "";
    if (/^\$|^\\\(|^\\\[/.test(seg)) return seg;
    return seg.replace(RAW_LATEX_RUN, (m) => {
      // Trailing whitespace stays OUTSIDE the $…$ so two wrapped runs don't butt together ("π/3,5π/3").
      const body = m.replace(/\s+$/, "");
      if (!/[=+\-*/0-9πθμ√^{}]/.test(body.replace(/\\[a-zA-Z]+/g, ""))) return m;
      return `$${body.trim()}$${m.slice(body.length)}`;
    });
  }).join("");
}

/** Strip backslash syntax left OUTSIDE $…$ / \(…\) segments — prose must never print a raw backslash
 *  (reported live: "… = 1.8\ J", "v ≈ 2.68\ m/s"). Segments that ARE math are left untouched for KaTeX. */
function stripBackslashesOutsideMath(line: string): string {
  if (!line.includes("\\")) return line;
  const parts = line.split(/(\$[^$\n]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g);
  return parts.map((seg) => (!seg ? "" : /^\$|^\\\(|^\\\[/.test(seg)
    ? seg
    : seg.replace(/\\\s+/g, " ").replace(/\\([a-zA-Z]+)/g, "$1").replace(/\\/g, ""))).join("");
}

/** Wrap each math run of a plain line in $…$ (leaves prose alone). */
export function autoMathLine(line: string): string {
  // Multi-line text (a board summary, a chat reply): process line-by-line so a $…$ span never crosses a
  // newline (MathText's split pattern is $[^$\n]+$ — a cross-line span would print its raw delimiters),
  // and so fenced code blocks pass through byte-for-byte (rewriting "x = 1" inside a fence to "$x = 1$"
  // would corrupt the code).
  if (line.includes("\n")) {
    let fence = false;
    return line.split("\n").map((l) => { if (/^\s*```/.test(l)) { fence = !fence; return l; } return fence ? l : autoMathLine(l); }).join("\n");
  }
  // Bare LaTeX first: without this the line trips the early return below and the commands are printed
  // literally (or read as prose) instead of typesetting.
  line = wrapRawLatex(line);
  if (/\$|\\\(|\\\[|\\[a-zA-Z]+\{/.test(line)) return stripBackslashesOutsideMath(line);
  // peel trailing sentence punctuation off a maths token ("5π/12?" → "5π/12" + "?") so it stays outside the $…$
  const toks = line.split(/(\s+)/).flatMap((t) => { const m = /^(.+?)([?!.,;:]+)$/.exec(t); return m && isMathToken(m[1]) && !/^\s+$/.test(t) ? [m[1], m[2]] : [t]; });
  const out: string[] = [];
  let run: string[] = [], trail = "";
  const flush = () => {
    if (!run.length) return;
    const raw = run.join("").trim();
    // Wrap only when there's a real expression: a run with NO letters/digits at all (a lone "-", a table
    // rule "|---|:---:|") is structure, not maths — wrapping it would turn bullets into $-$ and break
    // markdown tables. A run that IS a LaTeX command wraps even without =/operator, so "\sin x" alone
    // typesets instead of printing a raw backslash.
    if (/^\\[a-zA-Z]+/.test(raw) || (/[=+\-−×·÷/^√π→<>≤≥≈≠°]|->|=>|[A-Za-z]+\(/.test(raw) && /[\p{L}\p{N}]/u.test(raw))) out.push(`$${plainMathToLatex(raw)}$` + trail);
    else out.push(run.join("") + trail);
    run = []; trail = "";
  };
  let pendingSpace = "";
  for (const t of toks) {
    if (/^\s+$/.test(t)) { if (run.length) pendingSpace = t; else out.push(t); continue; }
    if (isMathToken(t)) { if (run.length) run.push(pendingSpace); run.push(t); pendingSpace = ""; }
    else { if (run.length) { trail = pendingSpace; flush(); pendingSpace = ""; } out.push(t); }
  }
  if (run.length) { trail = ""; flush(); }
  return stripBackslashesOutsideMath(out.join(""));
}

/** Repair LaTeX whose backslash a JSON/tool round-trip ate: "\\cdot"→"cdot", "^\\circ"→"^circ", and "\\t"/"\\f"/"\\b" turned into a
 *  tab / form-feed / backspace character ("\\tan"→TAB+"an", "\\frac"→FF+"rac"). Without this the board shows "k cdot \\tan 50^circ". Pure. */
export function repairLatex(text: string): string {
  const t = String(text || "");
  const mathy = /[=^\\]/.test(t); // a bare "cdot" is only repaired inside something that already looks like maths
  return t
    .replace(/\x09(?=an\b|imes\b|heta\b|ext\b|o\b)/g, "\\t")
    .replace(/\x0c(?=rac\b|dfrac\b)/g, "\\f")
    .replace(/\x08(?=eta\b|inom\b|ar\b)/g, "\\b")
    .replace(/\^\{?circ\}?/g, "^\\circ")
    .replace(/(?<=[\s)\d])cdot(?=[\s(\d\\])/g, (m) => (mathy ? "\\cdot" : m));
}


/** LaTeX → readable plain text, for the places KaTeX can't go (SVG figure labels, aria-labels, the fallback
 *  when KaTeX itself fails). Nested fractions resolve innermost-first, ^\circ becomes °, and layout-only
 *  commands (\displaystyle, \left, \right, spacing) vanish instead of printing as "displaystyle" / "circ". */
export function latexToPlainText(latex: string): string {
  let s = repairLatex(String(latex || ""));
  s = s.replace(/\\(?:displaystyle|textstyle|scriptstyle|left|right|big|Big|bigg|Bigg)\b/g, "")
    .replace(/\\[,;:! ]|\\q?quad\b/g, " ")
    .replace(/\^\s*\{?\\circ\}?/g, "°").replace(/\\circ\b/g, "°")
    .replace(/\\(?:text|mathrm|mathbf|operatorname)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)")
    .replace(/\\(arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|cot|sec|csc|log|ln|exp)\b/g, "$1");
  for (let i = 0; i < 6 && /\\[dtc]?frac/.test(s); i++) {
    s = s.replace(/\\[dtc]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a: string, b: string) => {
      const wrap = (x: string) => (/^[\w.°√π()]+$/u.test(x.trim()) ? x.trim() : `(${x.trim()})`);
      return `${wrap(a)}/${wrap(b)}`;
    }).replace(/\\[dtc]?frac\s*(\d)(\d)/g, "$1/$2");
  }
  const SYM: Record<string, string> = { cdot: "·", times: "×", div: "÷", pi: "π", theta: "θ", alpha: "α", beta: "β", infty: "∞", approx: "≈", neq: "≠", ne: "≠", leq: "≤", le: "≤", geq: "≥", ge: "≥", pm: "±", Rightarrow: "⇒", to: "→", rightarrow: "→" };
  s = s.replace(/\\([a-zA-Z]+)/g, (_, c: string) => SYM[c] ?? c).replace(/[{}]/g, "");
  return s.replace(/\s{2,}/g, " ").trim();
}
