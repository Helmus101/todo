import katex from "katex";
import { autoMathLine, repairLatex } from "../shared/mathText.ts";

/** The first maths span in a board line that KaTeX cannot typeset, with KaTeX's own message — or null when
 *  every span renders. Runs the SAME preparation the board does (repairLatex → autoMathLine), so what passes
 *  here is exactly what the student's board will typeset. A failing line is bounced back to the model to
 *  rewrite instead of reaching the board as raw "\frac{h}{100 + …" source (reported live). Pure. */
export function unrenderableMath(text: string): { latex: string; message: string } | null {
  const prepared = autoMathLine(repairLatex(String(text || "")));
  const spans = prepared.match(/\$\$[^$]+\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g) || [];
  for (const span of spans) {
    const latex = span.replace(/^\$\$|\$\$$|^\$|\$$|^\\\(|\\\)$|^\\\[|\\\]$/g, "").trim();
    if (!latex) continue;
    try { katex.renderToString(latex, { throwOnError: true, strict: false, trust: false, output: "html" }); }
    catch (e) { return { latex, message: String((e as Error)?.message || e).replace(/^KaTeX parse error:\s*/, "").slice(0, 160) }; }
  }
  return null;
}
