// Geometry → figure compiler. The old DRAW_ON_BOARD made the model do pixel arithmetic (a 0-800 × 0-600 space,
// one coordinate per vertex), and models are bad at it: triangles that don't close, 3-4-5 triangles that aren't,
// labels sitting on lines, angle marks missing. Here the model states the MATHS instead — named points in real
// units, segments between them, circles, angle marks, derived points (midpoint, foot of an altitude) — and this
// pure function does the drawing arithmetic: it solves triangles from side lengths, projects everything with ONE
// uniform scale (so 3-4-5 really is a right triangle and a circle really is round), flips y (maths y points up),
// places every label outside the figure, and emits ordinary DiagramOps for the existing board renderer.
import type { DiagramOp } from "./types.ts";

type Pt = { x: number; y: number };
export interface GeoSegment { from: string; to: string; label?: string; dashed?: boolean; ticks?: number; arrow?: boolean; color?: string }
export interface GeoSpec {
  /** Named points in real units, maths orientation (y up): {"A":[0,0],"B":[4,0]} or [{name,x,y}]. */
  points?: Record<string, [number, number]> | { name: string; x: number; y: number }[];
  /** Solve a triangle from its three side lengths: names [A,B,C], sides [a=BC, b=CA, c=AB]. Adds the three points + the three sides. */
  triangle?: { names: [string, string, string]; sides: [number, number, number]; labelSides?: boolean };
  /** Points computed from others, in order. */
  derive?: ({ name: string; kind: "midpoint"; of: [string, string] } | { name: string; kind: "foot"; from: string; onto: [string, string] } | { name: string; kind: "polar"; from: string; dist: number; deg: number })[];
  /** "AB" or {from,to,label,dashed,ticks,arrow,color}. */
  segments?: (string | GeoSegment)[];
  /** Closed shapes, e.g. "ABC" or {points:["A","B","C"], fill:true}. */
  polygons?: (string | { points: string[]; fill?: boolean; color?: string })[];
  /** center + r (real units) or center + through (a point on the circle). */
  circles?: { center: string; r?: number; through?: string; label?: string; dashed?: boolean; fill?: boolean }[];
  /** Circular arc about a center from `from` to `to` degrees counter-clockwise (maths orientation) — sectors, arcs. */
  arcs?: { center: string; r: number; from: number; to: number; label?: string; dashed?: boolean }[];
  /** An angle mark at vertex `at` between rays to `from` and `to`; `right` draws the little square. */
  angles?: { at: string; from: string; to: string; label?: string; right?: boolean }[];
  /** Points that get a dot + name label (default: every named point). */
  unlabeled?: string[];
}

export const GEO_LIMITS = { points: 26, shapes: 40 };
const W = 800, H = 600, MARGIN_X = 96, MARGIN_Y = 72;

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const finite = (v: unknown): v is number => Number.isFinite(num(v));
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: Pt) => Math.hypot(a.x, a.y);
const unit = (a: Pt): Pt => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Split "ABC" / "A'B" into known point names, longest-match first. */
function parseNames(s: string, known: Set<string>): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let hit = "";
    for (let l = Math.min(4, s.length - i); l >= 1; l--) if (known.has(s.slice(i, i + l))) { hit = s.slice(i, i + l); break; }
    if (!hit) return null;
    out.push(hit); i += hit.length;
  }
  return out;
}

export function buildGeometry(spec: GeoSpec): { ops: DiagramOp[] } | { error: string } {
  const P = new Map<string, Pt>();
  const add = (name: string, x: number, y: number) => { P.set(String(name).trim(), { x, y }); };
  if (Array.isArray(spec.points)) {
    for (const p of spec.points) { if (!p || !finite(p.x) || !finite(p.y) || !String(p.name || "").trim()) return { error: "ERROR: every point needs a name and numeric x, y." }; add(p.name, num(p.x), num(p.y)); }
  } else if (spec.points && typeof spec.points === "object") {
    for (const [name, xy] of Object.entries(spec.points)) {
      if (!Array.isArray(xy) || xy.length < 2 || !finite(xy[0]) || !finite(xy[1])) return { error: `ERROR: point ${name} must be [x, y] in real units, e.g. "${name}": [0, 0].` };
      add(name, num(xy[0]), num(xy[1]));
    }
  }
  const segs: GeoSegment[] = [];
  const tri = spec.triangle;
  if (tri) {
    const [A, B, C] = tri.names, [a, b, c] = (tri.sides || []).map(num);
    if (![a, b, c].every((v) => Number.isFinite(v) && v > 0)) return { error: "ERROR: triangle.sides needs three positive numbers [a=BC, b=CA, c=AB]." };
    if (a + b <= c + 1e-9 || a + c <= b + 1e-9 || b + c <= a + 1e-9) return { error: `ERROR: sides ${a}, ${b}, ${c} can't form a triangle (each side must be shorter than the other two together).` };
    const cosA = (b * b + c * c - a * a) / (2 * b * c);
    add(A, 0, 0); add(B, c, 0); add(C, b * cosA, b * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
    const lab = tri.labelSides !== false;
    segs.push({ from: A, to: B, ...(lab ? { label: String(c) } : {}) }, { from: B, to: C, ...(lab ? { label: String(a) } : {}) }, { from: C, to: A, ...(lab ? { label: String(b) } : {}) });
  }
  for (const d of spec.derive || []) {
    if (d.kind === "midpoint") {
      const [p, q] = [P.get(d.of?.[0]), P.get(d.of?.[1])]; if (!p || !q) return { error: `ERROR: midpoint ${d.name}: unknown point in "of" (${d.of}). Define it in points first.` };
      add(d.name, (p.x + q.x) / 2, (p.y + q.y) / 2);
    } else if (d.kind === "foot") {
      const [p, q, r] = [P.get(d.from), P.get(d.onto?.[0]), P.get(d.onto?.[1])]; if (!p || !q || !r) return { error: `ERROR: foot ${d.name}: unknown point in from/onto.` };
      const dir = sub(r, q), l2 = dir.x * dir.x + dir.y * dir.y; if (!l2) return { error: `ERROR: foot ${d.name}: the line's two points coincide.` };
      const t = ((p.x - q.x) * dir.x + (p.y - q.y) * dir.y) / l2;
      add(d.name, q.x + t * dir.x, q.y + t * dir.y);
    } else if (d.kind === "polar") {
      const p = P.get(d.from); if (!p || !finite(d.dist) || !finite(d.deg)) return { error: `ERROR: polar ${d.name}: needs a known "from" point, dist and deg.` };
      const rad = (num(d.deg) * Math.PI) / 180; add(d.name, p.x + num(d.dist) * Math.cos(rad), p.y + num(d.dist) * Math.sin(rad));
    } else return { error: `ERROR: unknown derive kind "${(d as any).kind}" — use midpoint, foot or polar.` };
  }
  if (!P.size) return { error: "ERROR: give at least one point (or a triangle)." };
  if (P.size > GEO_LIMITS.points) return { error: `REJECTED: max ${GEO_LIMITS.points} points.` };
  const known = new Set(P.keys());
  const need = (name: string, what: string): Pt | string => P.get(name) || `ERROR: ${what} uses "${name}", which is not a defined point (defined: ${[...known].join(", ")}).`;

  for (const s of spec.segments || []) {
    if (typeof s === "string") { const n = parseNames(s.replace(/[\s-]/g, ""), known); if (!n || n.length !== 2) return { error: `ERROR: segment "${s}" must be two defined points, e.g. "AB" (defined: ${[...known].join(", ")}).` }; segs.push({ from: n[0], to: n[1] }); }
    else if (s && P.has(s.from) && P.has(s.to)) segs.push(s);
    else return { error: `ERROR: segment ${JSON.stringify(s)} uses an undefined point (defined: ${[...known].join(", ")}).` };
  }
  const polys: { pts: string[]; fill?: boolean; color?: string }[] = [];
  for (const g of spec.polygons || []) {
    const names = typeof g === "string" ? parseNames(g.replace(/[\s-]/g, ""), known) : (g?.points || []).every((n) => known.has(n)) ? g.points : null;
    if (!names || names.length < 3) return { error: `ERROR: polygon ${JSON.stringify(g)} needs 3+ defined points.` };
    polys.push({ pts: names, ...(typeof g === "object" ? { fill: g.fill, color: g.color } : {}) });
  }
  if (segs.length + polys.length + (spec.circles?.length || 0) + (spec.arcs?.length || 0) + (spec.angles?.length || 0) > GEO_LIMITS.shapes) return { error: `REJECTED: max ${GEO_LIMITS.shapes} shapes — simplify.` };

  // ---- bounding box in real units (points, circles, arcs) -> one uniform scale ----
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  for (const p of P.values()) grow(p.x, p.y);
  const circles: { c: Pt; r: number; spec: NonNullable<GeoSpec["circles"]>[number] }[] = [];
  for (const c of spec.circles || []) {
    const ctr = need(c.center, "circle"); if (typeof ctr === "string") return { error: ctr };
    let r = finite(c.r) ? num(c.r) : NaN;
    if (!Number.isFinite(r) && c.through) { const t = need(c.through, "circle.through"); if (typeof t === "string") return { error: t }; r = len(sub(t, ctr)); }
    if (!(r > 0)) return { error: `ERROR: circle at ${c.center} needs a positive r or a "through" point.` };
    grow(ctr.x - r, ctr.y - r); grow(ctr.x + r, ctr.y + r); circles.push({ c: ctr, r, spec: c });
  }
  const arcs: { c: Pt; r: number; from: number; to: number; spec: NonNullable<GeoSpec["arcs"]>[number] }[] = [];
  for (const a of spec.arcs || []) {
    const ctr = need(a.center, "arc"); if (typeof ctr === "string") return { error: ctr };
    if (!(num(a.r) > 0) || !finite(a.from) || !finite(a.to)) return { error: `ERROR: arc at ${a.center} needs r > 0 and from/to in degrees.` };
    let to = num(a.to); const from = num(a.from); while (to <= from) to += 360;
    const r = num(a.r); grow(ctr.x - r, ctr.y - r); grow(ctr.x + r, ctr.y + r); arcs.push({ c: ctr, r, from, to, spec: a });
  }
  const spanX = Math.max(maxX - minX, 1e-9), spanY = Math.max(maxY - minY, 1e-9);
  const k = Math.min((W - 2 * MARGIN_X) / spanX, (H - 2 * MARGIN_Y) / spanY, 400);
  const ox = (W - spanX * k) / 2, oy = (H - spanY * k) / 2;
  const px = (p: Pt): Pt => ({ x: r1(ox + (p.x - minX) * k), y: r1(oy + (maxY - p.y) * k) });
  const S = new Map<string, Pt>(); for (const [n, p] of P) S.set(n, px(p));
  const centroid: Pt = { x: [...S.values()].reduce((s, p) => s + p.x, 0) / S.size, y: [...S.values()].reduce((s, p) => s + p.y, 0) / S.size };
  const awayFrom = (at: Pt, ref: Pt, fallback: Pt): Pt => { const d = sub(at, ref); return len(d) < 6 ? unit(fallback) : unit(d); };

  const ops: DiagramOp[] = [];
  const usedLabels: Pt[] = [];
  const label = (at: Pt, text: string, size: "sm" | "md" | "lg" = "md") => {
    let p = { ...at };
    for (let i = 0; i < 6 && usedLabels.some((u) => Math.abs(u.x - p.x) < 26 && Math.abs(u.y - p.y) < 18); i++) p = { x: p.x + 12, y: p.y + 14 };
    usedLabels.push(p);
    ops.push({ op: "label", x: r1(Math.min(780, Math.max(20, p.x))), y: r1(Math.min(585, Math.max(16, p.y))), text: text.slice(0, 40), size, anchor: "middle" });
  };

  for (const g of polys) ops.push({ op: "polygon", points: g.pts.map((n) => S.get(n)!), ...(g.fill ? { fill: true } : {}), ...(g.color ? { color: g.color } : {}) });
  for (const { c, r, spec: cs } of circles) {
    const sc = px(c); ops.push({ op: "circle", cx: sc.x, cy: sc.y, r: r1(r * k), ...(cs.fill ? { fill: true } : {}), ...(cs.dashed ? { dashed: true } : {}) });
    if (cs.label) label({ x: sc.x + r * k * 0.72, y: sc.y - r * k * 0.72 - 8 }, cs.label);
  }
  for (const { c, r, from, to, spec: as } of arcs) {
    const sc = px(c);
    ops.push({ op: "arc", cx: sc.x, cy: sc.y, r: r1(r * k), a0: -from, a1: -to, ...(as.dashed ? { dashed: true } : {}) });
    if (as.label) { const mid = (-(from + to) / 2 * Math.PI) / 180; label({ x: sc.x + (r * k + 18) * Math.cos(mid), y: sc.y + (r * k + 18) * Math.sin(mid) }, as.label); }
  }
  for (const s of segs) {
    const a = S.get(s.from)!, b = S.get(s.to)!;
    ops.push({ op: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...(s.arrow ? { arrow: true } : {}), ...(s.dashed ? { dashed: true } : {}), ...(s.color ? { color: s.color } : {}) });
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d = unit(sub(b, a)), n = { x: -d.y, y: d.x };
    const out = (n.x * (mid.x - centroid.x) + n.y * (mid.y - centroid.y)) >= 0 ? n : { x: -n.x, y: -n.y };
    for (let t = 0; t < Math.min(3, s.ticks || 0); t++) {
      const off = (t - ((Math.min(3, s.ticks || 0) - 1) / 2)) * 7, c0 = { x: mid.x + d.x * off, y: mid.y + d.y * off };
      ops.push({ op: "line", x1: r1(c0.x - n.x * 6), y1: r1(c0.y - n.y * 6), x2: r1(c0.x + n.x * 6), y2: r1(c0.y + n.y * 6) });
    }
    if (s.label) label({ x: mid.x + out.x * 20, y: mid.y + out.y * 20 }, String(s.label));
  }
  for (const an of spec.angles || []) {
    const v = S.get(an.at), p = S.get(an.from), q = S.get(an.to);
    if (!v || !p || !q) return { error: `ERROR: angle at ${an.at} uses an undefined point (defined: ${[...known].join(", ")}).` };
    const u1 = unit(sub(p, v)), u2 = unit(sub(q, v));
    if (an.right) {
      const s = 16; ops.push({ op: "polyline", points: [{ x: r1(v.x + u1.x * s), y: r1(v.y + u1.y * s) }, { x: r1(v.x + (u1.x + u2.x) * s), y: r1(v.y + (u1.y + u2.y) * s) }, { x: r1(v.x + u2.x * s), y: r1(v.y + u2.y * s) }] });
      if (an.label) label({ x: v.x + (u1.x + u2.x) * 30, y: v.y + (u1.y + u2.y) * 30 }, an.label, "sm");
    } else {
      const t1 = Math.atan2(u1.y, u1.x), t2 = Math.atan2(u2.y, u2.x);
      let dlt = ((t2 - t1) * 180) / Math.PI; while (dlt > 180) dlt -= 360; while (dlt <= -180) dlt += 360;
      const a0 = (t1 * 180) / Math.PI, R = 30;
      ops.push({ op: "arc", cx: v.x, cy: v.y, r: R, a0: r1(a0), a1: r1(a0 + dlt) });
      if (an.label) { const mid = ((a0 + dlt / 2) * Math.PI) / 180; label({ x: v.x + (R + 20) * Math.cos(mid), y: v.y + (R + 20) * Math.sin(mid) }, an.label, "sm"); }
    }
  }
  const hidden = new Set(spec.unlabeled || []);
  for (const [name, p] of S) {
    ops.push({ op: "circle", cx: p.x, cy: p.y, r: 3.5, fill: true });
    if (hidden.has(name)) continue;
    const nb = [...segs.filter((s) => s.from === name).map((s) => S.get(s.to)!), ...segs.filter((s) => s.to === name).map((s) => S.get(s.from)!)];
    // away from the lines meeting here; a lone point (a circle's centre) goes below-right
    const dir = nb.length ? unit(nb.reduce((acc, q) => { const u = unit(sub(q, p)); return { x: acc.x - u.x, y: acc.y - u.y }; }, { x: 0, y: 0 })) : awayFrom(p, centroid, { x: 0.6, y: 0.8 });
    const dd = len(dir) < 0.2 ? awayFrom(p, centroid, { x: 0, y: -1 }) : dir;
    label({ x: p.x + dd.x * 18, y: p.y + dd.y * 18 }, name);
  }
  return { ops };
}
