// 3D solids for the board (SOLID_ON_BOARD). A model drawing a cuboid or a pyramid free-hand gets the hidden edges, the
// vertex naming and the proportions wrong, so the app COMPUTES the figure: it projects the solid with the textbook
// "cabinet" oblique projection (front face true shape, depth receding up-right at half length), draws the hidden edges
// dashed, names the vertices, labels only the GIVEN dimensions, and can mark extra lines (a space diagonal, a height).
// Pure — the server calls it, tests cover it. The result is plain SVG that goes through the same sanitizer as every figure.

export type SolidShape = "cuboid" | "cube" | "pyramid" | "prism" | "cylinder" | "cone" | "sphere";

export interface SolidIn {
  shape: SolidShape;
  width?: number; height?: number; depth?: number; radius?: number; // proportions only (any unit) — placed to scale
  dims?: { width?: string; height?: string; depth?: string; radius?: string }; // labels to print (given values or letters)
  labels?: boolean;                                                  // name the vertices (default true)
  highlight?: { from: string; to: string; label?: string; dashed?: boolean }[]; // extra lines between named vertices
}

type P3 = { x: number; y: number; z: number };
const TH = (40 * Math.PI) / 180, K = 0.5;
const proj = (p: P3) => ({ x: p.x + K * p.z * Math.cos(TH), y: p.y + K * p.z * Math.sin(TH) }); // y up
const esc = (s: string) => String(s || "").replace(/[<>&"]/g, "").slice(0, 24);
const f = (n: number) => Math.round(n * 10) / 10;
const COLORS = ["#DC2626", "#2563EB", "#16A34A"];

interface Poly { v: Record<string, P3>; edges: [string, string][]; hidden: string[]; w: [string, string]; h?: [string, string]; d?: [string, string] }

function polyhedron(shape: SolidShape, w: number, h: number, d: number): Poly {
  if (shape === "pyramid") {
    const v = { A: { x: 0, y: 0, z: 0 }, B: { x: w, y: 0, z: 0 }, C: { x: w, y: 0, z: d }, D: { x: 0, y: 0, z: d }, E: { x: w / 2, y: h, z: d / 2 } };
    return { v, edges: [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"], ["E", "A"], ["E", "B"], ["E", "C"], ["E", "D"]], hidden: ["CD", "DA", "ED"], w: ["A", "B"], d: ["B", "C"] };
  }
  if (shape === "prism") {
    const v = { A: { x: 0, y: 0, z: 0 }, B: { x: w, y: 0, z: 0 }, C: { x: w / 2, y: h, z: 0 }, D: { x: 0, y: 0, z: d }, E: { x: w, y: 0, z: d }, F: { x: w / 2, y: h, z: d } };
    return { v, edges: [["A", "B"], ["B", "C"], ["C", "A"], ["D", "E"], ["E", "F"], ["F", "D"], ["A", "D"], ["B", "E"], ["C", "F"]], hidden: ["DE", "AD", "FD"], w: ["A", "B"], h: ["A", "C"], d: ["B", "E"] };
  }
  const v = { A: { x: 0, y: 0, z: 0 }, B: { x: w, y: 0, z: 0 }, C: { x: w, y: h, z: 0 }, D: { x: 0, y: h, z: 0 }, E: { x: 0, y: 0, z: d }, F: { x: w, y: 0, z: d }, G: { x: w, y: h, z: d }, H: { x: 0, y: h, z: d } };
  return { v, edges: [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"], ["E", "F"], ["F", "G"], ["G", "H"], ["H", "E"], ["A", "E"], ["B", "F"], ["C", "G"], ["D", "H"]], hidden: ["EF", "EH", "AE"], w: ["A", "B"], h: ["A", "D"], d: ["B", "F"] };
}

export function buildSolid(input: SolidIn): { svg: string; facts: string } | { error: string } {
  const shape = input.shape;
  if (!["cuboid", "cube", "pyramid", "prism", "cylinder", "cone", "sphere"].includes(shape)) return { error: "ERROR: shape must be cuboid, cube, pyramid, prism, cylinder, cone or sphere." };
  const pos = (n: unknown, dflt: number) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : dflt);
  const dims = input.dims || {};
  const showLabels = input.labels !== false;
  const W = 800, H = 460, M = 70;
  const parts: string[] = [];
  const line = (a: { x: number; y: number }, b: { x: number; y: number }, extra = "") => `<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" ${/stroke="/.test(extra) ? "" : 'stroke="currentColor" '}${/stroke-width="/.test(extra) ? "" : 'stroke-width="2" '}${extra}/>`;
  const text = (x: number, y: number, s: string, extra = "") => `<text x="${f(x)}" y="${f(y)}" ${/font-size="/.test(extra) ? "" : 'font-size="18" '}${/fill="/.test(extra) ? "" : 'fill="currentColor" '}font-family="Inter, system-ui, sans-serif" ${extra}>${esc(s)}</text>`;
  const finish = (facts: string) => ({ svg: `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`, facts });

  // ── round solids: drawn directly (axis vertical), ellipses for the circles ──
  if (shape === "cylinder" || shape === "cone" || shape === "sphere") {
    const r0 = pos(input.radius, 1), h0 = shape === "sphere" ? 2 * r0 : pos(input.height, 2 * r0);
    const k = 0.32;                                    // ellipse flattening
    const sc = Math.min((W - 2 * M - 120) / (2 * r0), (H - 2 * M) / (h0 + 2 * k * r0));
    const r = r0 * sc, hh = h0 * sc, cx = W / 2 - 40, baseY = H - M - k * r;
    const ellipse = (cy: number, rx: number, ry: number, front: boolean, back: boolean) => {
      if (front) parts.push(`<path d="M ${f(cx - rx)} ${f(cy)} A ${f(rx)} ${f(ry)} 0 0 0 ${f(cx + rx)} ${f(cy)}" fill="none" stroke="currentColor" stroke-width="2"/>`);
      if (back) parts.push(`<path d="M ${f(cx - rx)} ${f(cy)} A ${f(rx)} ${f(ry)} 0 0 1 ${f(cx + rx)} ${f(cy)}" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="7 6"/>`);
    };
    if (shape === "sphere") {
      const cy = H / 2;
      parts.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="none" stroke="currentColor" stroke-width="2"/>`);
      ellipse(cy, r, r * k, true, true);
      parts.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="3.5" fill="currentColor"/>`, text(cx + 8, cy - 8, "O", 'font-weight="600"'));
      if (dims.radius) { parts.push(line({ x: cx, y: cy }, { x: cx + r, y: cy }, `stroke="${COLORS[0]}"`), text(cx + r / 2 - 6, cy - 10, dims.radius, `fill="${COLORS[0]}"`)); }
      return finish("a sphere with centre O; the equator is drawn dashed at the back");
    }
    const topY = baseY - hh;
    ellipse(baseY, r, r * k, true, true);
    if (shape === "cylinder") {
      parts.push(`<ellipse cx="${f(cx)}" cy="${f(topY)}" rx="${f(r)}" ry="${f(r * k)}" fill="none" stroke="currentColor" stroke-width="2"/>`);
      parts.push(line({ x: cx - r, y: baseY }, { x: cx - r, y: topY }), line({ x: cx + r, y: baseY }, { x: cx + r, y: topY }));
    } else {
      parts.push(line({ x: cx - r, y: baseY }, { x: cx, y: topY }), line({ x: cx + r, y: baseY }, { x: cx, y: topY }));
    }
    parts.push(`<circle cx="${f(cx)}" cy="${f(baseY)}" r="3.5" fill="currentColor"/>`);
    if (dims.radius) { parts.push(line({ x: cx, y: baseY }, { x: cx + r, y: baseY }, `stroke="${COLORS[0]}"`), text(cx + r / 2 - 6, baseY + 24, dims.radius, `fill="${COLORS[0]}"`)); }
    if (dims.height) { parts.push(line({ x: cx, y: baseY }, { x: cx, y: topY }, `stroke="${COLORS[1]}" stroke-dasharray="7 6"`), text(cx + 10, (baseY + topY) / 2, dims.height, `fill="${COLORS[1]}"`)); }
    return finish(`a ${shape} with its axis vertical; the back half of the base circle is dashed${dims.radius ? "; the radius is marked on the base" : ""}`);
  }

  // ── polyhedra: cabinet projection ──
  const w0 = pos(input.width, 1), h0 = shape === "cube" ? w0 : pos(input.height, 1), d0 = shape === "cube" ? w0 : pos(input.depth, 1);
  const poly = polyhedron(shape === "cube" ? "cuboid" : shape, w0, h0, d0);
  const pts: Record<string, { x: number; y: number }> = {};
  for (const [n, p] of Object.entries(poly.v)) pts[n] = proj(p);
  const xs = Object.values(pts).map((p) => p.x), ys = Object.values(pts).map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const sc = Math.min((W - 2 * M - 80) / (maxX - minX || 1), (H - 2 * M) / (maxY - minY || 1));
  const ox = M + 30 - minX * sc, oy = H - M + minY * sc;
  const P: Record<string, { x: number; y: number }> = {};
  for (const [n, p] of Object.entries(pts)) P[n] = { x: ox + p.x * sc, y: oy - p.y * sc };
  const cen = { x: (Math.min(...Object.values(P).map((p) => p.x)) + Math.max(...Object.values(P).map((p) => p.x))) / 2, y: (Math.min(...Object.values(P).map((p) => p.y)) + Math.max(...Object.values(P).map((p) => p.y))) / 2 };

  for (const [a, b] of poly.edges) {
    const hid = poly.hidden.includes(a + b) || poly.hidden.includes(b + a);
    parts.push(line(P[a], P[b], hid ? 'stroke-dasharray="7 6" opacity="0.7"' : ""));
  }
  const used = new Set<string>();
  for (const hl of (input.highlight || []).slice(0, 3)) {
    const a = String(hl.from || "").toUpperCase(), b = String(hl.to || "").toUpperCase();
    if (!P[a] || !P[b] || a === b) continue;
    const c = COLORS[used.size % COLORS.length]; used.add(a + b);
    parts.push(line(P[a], P[b], `stroke="${c}" stroke-width="3"${hl.dashed ? ' stroke-dasharray="7 6"' : ""}`));
    if (hl.label) parts.push(text((P[a].x + P[b].x) / 2 + 8, (P[a].y + P[b].y) / 2 - 8, hl.label, `fill="${c}" font-style="italic"`));
  }
  if (showLabels) {
    for (const [n, p] of Object.entries(P)) {
      const dx = p.x - cen.x, dy = p.y - cen.y, len = Math.hypot(dx, dy) || 1;
      parts.push(`<circle cx="${f(p.x)}" cy="${f(p.y)}" r="3.5" fill="currentColor"/>`, text(p.x + (dx / len) * 20 - 6, p.y + (dy / len) * 20 + 6, n, 'font-weight="600"'));
    }
  }
  const mid = (e: [string, string]) => ({ x: (P[e[0]].x + P[e[1]].x) / 2, y: (P[e[0]].y + P[e[1]].y) / 2 });
  if (dims.width) { const m = mid(poly.w); parts.push(text(m.x - 14, m.y + 34, dims.width, `fill="${COLORS[0]}"`)); }
  if (dims.height && poly.h) { const m = mid(poly.h); parts.push(text(m.x - 48, m.y + 6, dims.height, `fill="${COLORS[1]}"`)); }
  if (dims.depth && poly.d) { const m = mid(poly.d); parts.push(text(m.x + 14, m.y + 6, dims.depth, `fill="${COLORS[2]}"`)); }
  const names = Object.keys(P).join("");
  const label = shape === "cube" ? "a cube" : shape === "cuboid" ? "a cuboid" : shape === "pyramid" ? "a square-based pyramid" : "a triangular prism";
  const where = shape === "pyramid" ? "base ABCD with A front-left, B front-right, C back-right, D back-left, apex E above the centre" : shape === "prism" ? "front triangle ABC (base AB, apex C), back triangle DEF behind it (D behind A, E behind B, F behind C)" : "front face ABCD (A bottom-left, B bottom-right, C top-right, D top-left), back face EFGH (E behind A, F behind B, G behind C, H behind D)";
  return finish(`${label} with vertices ${names}: ${where}; hidden edges are dashed${shape === "cuboid" || shape === "cube" ? "; the space diagonal runs from A to G, a face diagonal e.g. from A to C" : ""}`);
}
