// Model-authored SVG diagrams (SVG_ON_BOARD). Language models draw clear diagrams by writing SVG directly — that is
// how Claude and ChatGPT produce them — so the tutor does the same, and THIS file is the safety layer: a strict
// allowlist sanitizer (no scripts, no event handlers, no external references, no foreignObject/HTML). Pure and
// dependency-free so the server sanitises on write and the client sanitises again on render.

const ALLOWED_TAGS = new Set(["svg", "g", "defs", "marker", "path", "line", "polyline", "polygon", "rect", "circle", "ellipse", "text", "tspan", "title", "desc", "lineargradient", "radialgradient", "stop", "clippath", "symbol", "use"]);
const TAG_CASE: Record<string, string> = { lineargradient: "linearGradient", radialgradient: "radialGradient", clippath: "clipPath" };
const ATTR_OK = /^(?:[a-z][a-z0-9-]*|viewBox|preserveAspectRatio|markerWidth|markerHeight|markerUnits|refX|refY|gradientUnits|gradientTransform|patternUnits|clipPathUnits|textLength|lengthAdjust|stdDeviation|xml:space)$/i;
export const MAX_SVG_CHARS = 16000;

const cleanValue = (name: string, v: string): string | null => {
  const val = v.replace(/[\u0000-\u001f]/g, "").trim();
  const lower = val.toLowerCase();
  if (/javascript:|data:|vbscript:|<|>|expression\(|@import|&#/.test(lower)) return null;
  // url(...) is only allowed to point at an element in the same document (#id)
  if (/url\s*\(/i.test(val) && /url\s*\(\s*(?!['"]?#)/i.test(val)) return null;
  if ((name === "href" || name === "xlink:href") && !/^#[\w-]+$/.test(val)) return null;
  return val.slice(0, 600);
};

const GREEK: Record<string, string> = { alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Omega: "Ω",
  cdot: "·", times: "×", div: "÷", pm: "±", circ: "°", degree: "°", infty: "∞", approx: "≈", neq: "≠", ne: "≠", leq: "≤", le: "≤", geq: "≥", ge: "≥", to: "→", rightarrow: "→", Rightarrow: "⇒", parallel: "∥", perp: "⊥", angle: "∠", triangle: "△", sqrt: "√", ldots: "…", dots: "…" };
const SUB: Record<string, string> = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", x: "ₓ" };
const SUP: Record<string, string> = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "-": "⁻", n: "ⁿ" };
/** A figure label is plain SVG text, where KaTeX can't run: "$\theta$" / "$Mg$" / "$F_N$" / "$mg\sin\theta$" must read
 *  θ / Mg / F_N / "mg sin θ", never the raw LaTeX (reported live: a graph showed "$\theta$"). */
export function plainLabel(input: string): string {
  const s0 = String(input ?? "");
  if (!/[$\\^_]/.test(s0)) return s0;
  let s = s0.replace(/\$([^$]*)\$/g, "$1")
    .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname|vec|overrightarrow|hat|bar)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1/$2)")
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)")
    .replace(/\^\s*\{?\\circ\}?/g, "°")
    .replace(/\\(sin|cos|tan|ln|log|exp)\b\s*/g, " $1 ")
    .replace(/\\(?:left|right|displaystyle|,|;|!|quad|qquad)/g, " ")
    .replace(/\\([a-zA-Z]+)/g, (_, c: string) => GREEK[c] ?? c);
  const map = (t: string, m: Record<string, string>) => [...t].every((ch) => m[ch]) ? [...t].map((ch) => m[ch]).join("") : null;
  s = s.replace(/_\{([^{}]{1,6})\}|_([A-Za-z0-9])/g, (all, a, b) => map(a ?? b, SUB) ?? `_${a ?? b}`)
    .replace(/\^\{([^{}]{1,4})\}|\^([A-Za-z0-9-])/g, (all, a, b) => map(a ?? b, SUP) ?? `^${a ?? b}`)
    .replace(/[{}]/g, "");
  return s.replace(/\s{2,}/g, " ").trim();
}

/** Returns a clean `<svg …>…</svg>` string, or "" when the input has no usable svg root. */
export function sanitizeSvg(input: string): string {
  let src = String(input || "").slice(0, MAX_SVG_CHARS * 2);
  src = src.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/gi, "");
  const start = src.search(/<svg[\s>]/i);
  if (start < 0) return "";
  src = src.slice(start);
  const out: string[] = [];
  const stack: string[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^<>]*?)?)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let skipDepth = 0; // inside a disallowed element: drop everything until its matching close
  let sawRoot = false;
  while ((m = re.exec(src))) {
    if (m[4] !== undefined) {
      if (skipDepth) continue;
      // text content: keep, escaped
      out.push(plainLabel(m[4]).replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, "&amp;"));
      continue;
    }
    const raw = m[0], name = m[1].toLowerCase(), isClose = raw.startsWith("</"), selfClose = m[3] === "/" || /\/\s*>$/.test(raw);
    if (!ALLOWED_TAGS.has(name)) {
      if (!isClose && !selfClose) skipDepth++;
      else if (isClose && skipDepth) skipDepth--;
      continue;
    }
    if (skipDepth) continue;
    const tag = TAG_CASE[name] || name;
    if (isClose) {
      const i = stack.lastIndexOf(tag);
      if (i < 0) continue;
      while (stack.length > i) out.push(`</${stack.pop()}>`);
      if (!stack.length) break;
      continue;
    }
    if (!sawRoot && name !== "svg") return "";
    const attrs: string[] = [];
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[2] || ""))) {
      const an = a[1];
      if (/^on/i.test(an)) continue;
      if (!ATTR_OK.test(an) && an !== "xlink:href") continue;
      if (name === "svg" && /^(?:width|height|x|y|xmlns.*)$/i.test(an)) continue; // the app sizes the root
      const lname = an.toLowerCase();
      if (lname === "style") continue; // inline CSS can position a figure over the whole page (UI redress): the app styles figures itself
      if (lname === "xlink:href" && name !== "use") continue;
      const val = cleanValue(lname, a[2] ?? a[3] ?? "");
      if (val === null) continue;
      attrs.push(`${an}="${val.replace(/"/g, "&quot;")}"`);
    }
    if (name === "svg") {
      sawRoot = true;
      if (!attrs.some((x) => x.startsWith("viewBox="))) attrs.push('viewBox="0 0 800 500"');
      attrs.push('xmlns="http://www.w3.org/2000/svg"');
    }
    out.push(`<${tag}${attrs.length ? " " + attrs.join(" ") : ""}${selfClose ? "/" : ""}>`);
    if (!selfClose) stack.push(tag);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  const svg = out.join("");
  if (!sawRoot || svg.length > MAX_SVG_CHARS) return "";
  return svg;
}

/** Visible text inside an SVG (labels), for leak checks and the tutor's own view of the board. */
export function svgText(svg: string): string {
  return svg.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
