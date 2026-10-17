// What a graph on the board ACTUALLY shows, computed by code: where curves cross, where one is lowest. Otto's words about a
// figure ("MC cuts ATC at its lowest point", "they meet at Q = 4") and the student's read-offs ("about 4.81") are checked against
// this, not against the model's idea of what the curves should look like. Pure.
import { compileExpr } from "../../shared/mathExpr.ts";
import type { GraphSpec } from "../../shared/types.ts";

type Curve = { label: string; f: (x: number) => number };

function curvesOf(spec: GraphSpec): Curve[] {
  const names = ["x", ...(spec.params || []).map((p) => p.name)];
  const base = Object.fromEntries((spec.params || []).map((p) => [p.name, p.value]));
  const out: Curve[] = [];
  for (const f of spec.fns || []) {
    const c = compileExpr(f.expr, names);
    if ("fn" in c) out.push({ label: (f.label || f.expr).trim(), f: (x) => c.fn({ ...base, x }) });
  }
  return out;
}

const N = 1500;
const xs = (spec: GraphSpec) => Array.from({ length: N + 1 }, (_, i) => spec.xmin + ((spec.xmax - spec.xmin) * i) / N);

/** x-values where two curves cross (sign change of their difference), refined by bisection. */
export function crossings(a: Curve, b: Curve, spec: GraphSpec): number[] {
  const out: number[] = [];
  const grid = xs(spec);
  let prev = a.f(grid[0]) - b.f(grid[0]);
  for (let i = 1; i < grid.length; i++) {
    const d = a.f(grid[i]) - b.f(grid[i]);
    if (Number.isFinite(prev) && Number.isFinite(d) && prev !== 0 && prev * d < 0) {
      let lo = grid[i - 1], hi = grid[i];
      for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; const dm = a.f(mid) - b.f(mid); if ((a.f(lo) - b.f(lo)) * dm <= 0) hi = mid; else lo = mid; }
      out.push((lo + hi) / 2);
    }
    prev = d;
  }
  return out;
}

/** The interior minimum of a curve (x, y), or null when it is monotonic / the minimum sits on the window edge. */
export function interiorMin(c: Curve, spec: GraphSpec): { x: number; y: number } | null {
  const grid = xs(spec).filter((x) => x > spec.xmin + (spec.xmax - spec.xmin) * 0.02);
  let best: { x: number; y: number } | null = null;
  for (const x of grid) { const y = c.f(x); if (Number.isFinite(y) && (!best || y < best.y)) best = { x, y }; }
  if (!best) return null;
  const edge = (spec.xmax - spec.xmin) * 0.03;
  return best.x > spec.xmin + edge && best.x < spec.xmax - edge ? best : null;
}

/** A claim the speech makes about the figure ("A cuts B at B's lowest point", "A and B meet at x = 4") checked against the plotted curves.
 *  Returns the complaint, or null when there is no checkable claim or it holds. Works for any labelled curves, in any subject. */
export function figureClaimFalse(speech: string, spec: GraphSpec): string | null {
  const cs = curvesOf(spec);
  if (cs.length < 2) return null;
  const find = (tok: string) => cs.find((c) => new RegExp(`(?:^|[^a-z])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z]|$)`, "i").test(c.label));
  const span = spec.xmax - spec.xmin;
  // "<A> (curve) cuts/crosses/meets/passes through <B> (curve)'s lowest/highest point"
  const claims: { a: string; b: string; kind: string }[] = [];
  for (const m of speech.matchAll(/\b([A-Za-z]{1,12})(?: curve)?\s+(?:cuts|crosses|meets|intersects|passes through|hits)\s+(?:the\s+)?([A-Za-z]{1,12})(?:'s| curve's|\s+curve at its)?\s*(?:at\s+)?(?:its\s+)?(lowest|highest|minimum|maximum|bottom|top)\b/gi)) claims.push({ a: m[1], b: m[2], kind: m[3] });
  for (const m of speech.matchAll(/\b([A-Za-z]{1,12})(?: curve)?\s+(?:cuts|crosses|meets|intersects|passes|hits)(?:\s+through)?\s+the\s+(lowest|highest|minimum|maximum|bottom|top)\s+point\s+of\s+(?:the\s+)?([A-Za-z]{1,12})/gi)) claims.push({ a: m[1], b: m[3], kind: m[2] });
  for (const m of claims) {
    const a = find(m.a), b = find(m.b);
    if (!a || !b || a === b) continue;
    const lowest = /lowest|minimum|bottom/i.test(m.kind);
    const ext = lowest ? interiorMin(b, spec) : (() => { const r = interiorMin({ label: b.label, f: (x) => -b.f(x) }, spec); return r ? { x: r.x, y: -r.y } : null; })();
    if (!ext) return `${m.b} has no ${lowest ? "lowest" : "highest"} point inside the plotted window`;
    const cross = crossings(a, b, spec);
    if (!cross.some((x) => Math.abs(x - ext.x) <= 0.03 * span)) return `${m.b} is ${lowest ? "lowest" : "highest"} at x≈${ext.x.toFixed(2)} but ${m.a} ${cross.length ? `crosses it at x≈${cross.map((x) => x.toFixed(2)).join(", ")}` : "never crosses it"}`;
  }
  return null;
}

/** A short list of facts about every function graph on the board, for the facts block. */
export function graphFactsBlock(board: { n?: number; kind?: string; graph?: GraphSpec }[]): string {
  const lines: string[] = [];
  for (const e of board) {
    if (e.kind !== "graph" || !e.graph || (e.graph.kind && e.graph.kind !== "function") || !e.graph.fns?.length) continue;
    const spec = e.graph, cs = curvesOf(spec), bits: string[] = [];
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const xs2 = crossings(cs[i], cs[j], spec);
      if (xs2.length) bits.push(`${cs[i].label} and ${cs[j].label} cross at ${xs2.slice(0, 3).map((x) => `x≈${x.toFixed(2)} (y≈${cs[i].f(x).toFixed(2)})`).join(", ")}`);
    }
    for (const c of cs) { const m = interiorMin(c, spec); if (m) bits.push(`${c.label} is lowest at x≈${m.x.toFixed(2)} (y≈${m.y.toFixed(2)})`); }
    if (bits.length) lines.push(`graph ${e.n ? `#${e.n}` : ""}: ${bits.join("; ")}`);
  }
  return lines.length ? `\n\nWHAT THE GRAPHS ON THE BOARD ACTUALLY SHOW (computed — use these numbers when you or the student read a value off a graph; if the student reads something else, say what the graph gives):\n${lines.join("\n")}` : "";
}

/** Speech that points at shading / a rectangle on a figure. */
export const SHADE_CLAIM = /\b(?:shaded|shading|the (?:coloured|colored|highlighted) (?:area|region)|profit rectangle|(?:the|that|this) rectangle|surplus (?:triangle|area)|area (?:between|under))\b/i;
