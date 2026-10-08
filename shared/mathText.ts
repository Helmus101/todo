// Plain-text maths → inline LaTeX, for lines the tutor wrote as plain Unicode ("sin(π/3) = √3/2, cos(π/3) = 1/2")
// instead of $…$. Splits a line into prose words and "math runs", rewrites each run into LaTeX (fractions, roots,
// greek, function names, arrows) and wraps it in $…$ so the board can typeset it with KaTeX. Pure; if a line already
// contains `$`, `\(` or a LaTeX command it is returned untouched. A run KaTeX can't parse falls back to its plain
// text at render time (client), so a bad guess never breaks a line.
const FN = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp", "lim", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh"]);

const isMathToken = (t: string): boolean => {
  const bare = t.replace(/^[(\[{]+|[)\]},.;:]+$/g, "");
  if (!bare) return /[=+\-−×·÷/^<>≤≥≈≠→⇒]/.test(t);
  // an ordinary word (3+ letters that isn't a function name) is prose, even with a hyphen in it ("special-angle")
  for (const w of bare.match(/\p{L}{3,}/gu) || []) if (!FN.has(w.toLowerCase())) return false;
  if (FN.has(bare.toLowerCase())) return true; // "sin" / "cos" on their own: "sin A cos B"
  if (/^\p{L}$/u.test(bare)) return true; // a single-letter variable: x, A, θ
  if (/[0-9=+\-−×·÷/^<>≤≥≈≠→⇒√π∞∑∫°]|->|=>/.test(bare)) return true;
  const word = bare.match(/^[A-Za-z]+/)?.[0]?.toLowerCase() || "";
  if (FN.has(word) && /[(0-9π]/.test(bare.slice(word.length))) return true;
  return false;
};

const GREEK: [RegExp, string][] = [[/π/g, "\\pi "], [/θ/g, "\\theta "], [/α/g, "\\alpha "], [/β/g, "\\beta "], [/γ/g, "\\gamma "], [/λ/g, "\\lambda "], [/μ/g, "\\mu "], [/φ/g, "\\varphi "], [/ω/g, "\\omega "], [/Δ/g, "\\Delta "]];

/** Convert one plain-text math run to LaTeX. Exported for tests. */
export function plainMathToLatex(run: string): string {
  let s = run.trim();
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
    return seg.replace(/\\[a-zA-Z]+(?:\s*\{[^{}]*\}|\s*[A-Za-z](?![A-Za-z])|[\d+\-*/().=^_,:πθμ√∞\s])+/g, (m) => {
      // Trailing whitespace stays OUTSIDE the $…$ so two wrapped runs don't butt together ("π/3,5π/3").
      const body = m.replace(/\s+$/, "");
      if (!/[=+\-*/0-9πθμ√^{}]/.test(body.replace(/\\[a-zA-Z]+/g, ""))) return m;
      return `$${body.trim()}$${m.slice(body.length)}`;
    });
  }).join("");
}

/** Wrap each math run of a plain line in $…$ (leaves prose alone). */
export function autoMathLine(line: string): string {
  // Bare LaTeX first: without this the line trips the early return below and the commands are printed
  // literally (or read as prose) instead of typesetting.
  line = wrapRawLatex(line);
  if (/\$|\\\(|\\\[|\\[a-zA-Z]+\{/.test(line)) return line;
  // peel trailing sentence punctuation off a maths token ("5π/12?" → "5π/12" + "?") so it stays outside the $…$
  const toks = line.split(/(\s+)/).flatMap((t) => { const m = /^(.+?)([?!.,;:]+)$/.exec(t); return m && isMathToken(m[1]) && !/^\s+$/.test(t) ? [m[1], m[2]] : [t]; });
  const out: string[] = [];
  let run: string[] = [], trail = "";
  const flush = () => {
    if (!run.length) return;
    const raw = run.join("").trim();
    // a lone single letter / bare number is prose ("a", "2 steps"), not an equation
    if (/[=+\-−×·÷/^√π→<>≤≥≈≠°]|->|=>|[A-Za-z]+\(/.test(raw) || /^\p{L}\d?$/u.test(raw) && false) out.push(`$${plainMathToLatex(raw)}$` + trail);
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
  return out.join("");
}
