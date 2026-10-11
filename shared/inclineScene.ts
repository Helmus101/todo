// A block on an inclined plane, with its forces — INCLINE_ON_BOARD. Drawn free-hand (SVG_ON_BOARD) the model kept
// getting these wrong: a slope that isn't the stated angle, the normal force not perpendicular to the surface, the
// weight not vertical, components pointing the wrong way. Here the app COMPUTES the figure from the angle: the slope
// is drawn at exactly that angle, the weight straight down, the normal perpendicular to the surface, components along
// and into the slope, friction against the motion. Only the labels the tutor passes (the GIVEN values, "?" for
// unknowns) are written. Pure — the server calls it, tests check the geometry.

export type InclineForce = "weight" | "components" | "normal" | "friction" | "applied";
export interface InclineSceneIn {
  angle: number;                              // slope angle in degrees (0 < angle < 80)
  forces?: InclineForce[];                    // which arrows to draw (default: weight, normal)
  motion?: "up" | "down" | "none";            // which way the block moves along the slope (sets friction's direction)
  labels?: Partial<Record<InclineForce | "angle" | "block", string>>; // e.g. { weight: "mg", applied: "F = ?", angle: "12°" }
}

export const BOARD_FONT = "KaTeX_Main, 'Times New Roman', serif";
const rad = (d: number) => (d * Math.PI) / 180;
const f = (n: number) => Math.round(n * 10) / 10;
const esc = (s: string) => String(s || "").replace(/[<>&"]/g, "").slice(0, 24);
const COLORS: Record<InclineForce, string> = { weight: "#DC2626", components: "#DC2626", normal: "#2563EB", friction: "#B45309", applied: "#16A34A" };

export function buildInclineScene(input: InclineSceneIn): { svg: string; facts: string } | { error: string } {
  const th = Number(input.angle);
  if (!(th > 0 && th < 80)) return { error: "ERROR: the slope angle must be between 0° and 80°." };
  const forces = (input.forces?.length ? input.forces : ["weight", "normal"]).filter((x): x is InclineForce => ["weight", "components", "normal", "friction", "applied"].includes(x));
  const motion = input.motion === "down" ? "down" : input.motion === "none" ? "none" : "up";
  const L = input.labels || {};
  const t = rad(th), c = Math.cos(t), s = Math.sin(t);

  // ── the slope: A bottom-left, B bottom-right (right angle), C top-right; rising to the right at exactly θ ──
  const A = { x: 70, y: 410 };
  let base = 600;
  if (base * Math.tan(t) > 330) base = 330 / Math.tan(t);
  const B = { x: A.x + base, y: A.y }, C = { x: A.x + base, y: A.y - base * Math.tan(t) };
  const u = { x: c, y: -s };            // unit vector UP the slope (canvas y points down)
  const n = { x: -s, y: -c };           // unit normal pointing OUT of the surface
  const slopeLen = base / c;

  // ── the block: a square resting on the surface, 55% of the way up ──
  const side = 64, along = slopeLen * 0.55;
  const P = { x: A.x + u.x * along, y: A.y + u.y * along };       // contact point (middle of the block's base)
  const G = { x: P.x + n.x * side / 2, y: P.y + n.y * side / 2 }; // centre of mass
  const corner = (a: number, b: number) => ({ x: P.x + u.x * a + n.x * b, y: P.y + u.y * a + n.y * b });
  const blk = [corner(-side / 2, 0), corner(side / 2, 0), corner(side / 2, side), corner(-side / 2, side)];

  const parts: string[] = [];
  const text = (x: number, y: number, str: string, extra = "") => `<text x="${f(x)}" y="${f(y)}" font-size="20" fill="currentColor" font-family="${BOARD_FONT}" ${extra}>${esc(str)}</text>`;
  parts.push(`<defs>${(Object.keys(COLORS) as InclineForce[]).map((k) => `<marker id="ah-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${COLORS[k]}"/></marker>`).join("")}</defs>`);
  parts.push(`<path d="M ${f(A.x)} ${f(A.y)} L ${f(B.x)} ${f(B.y)} L ${f(C.x)} ${f(C.y)} Z" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-width="2"/>`);
  parts.push(`<path d="M ${f(B.x - 16)} ${f(B.y)} L ${f(B.x - 16)} ${f(B.y - 16)} L ${f(B.x)} ${f(B.y - 16)}" fill="none" stroke="currentColor" stroke-width="1.4"/>`);
  // the angle at A, exactly θ
  const r = 56;
  parts.push(`<path d="M ${f(A.x + r)} ${f(A.y)} A ${r} ${r} 0 0 0 ${f(A.x + r * c)} ${f(A.y - r * s)}" fill="none" stroke="currentColor" stroke-width="1.6"/>`);
  parts.push(text(A.x + r + 10, A.y - r * s / 2 + 4, L.angle || `${f(th)}°`));
  parts.push(`<polygon points="${blk.map((p) => `${f(p.x)},${f(p.y)}`).join(" ")}" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="2"/>`);
  if (L.block) parts.push(text(G.x - 8, G.y + 6, L.block, 'font-size="16"'));

  // ── forces ── arrows first, labels after (placed so none overlap each other or the figure's own text)
  type Lab = { x: number; y: number; w: number; h: number; str: string; color: string; dx: number; dy: number };
  const labels: Lab[] = [];
  const arrow = (k: InclineForce, from: { x: number; y: number }, dx: number, dy: number, len: number, label: string | undefined, dashed = false) => {
    const end = { x: from.x + dx * len, y: from.y + dy * len };
    parts.push(`<line x1="${f(from.x)}" y1="${f(from.y)}" x2="${f(end.x)}" y2="${f(end.y)}" stroke="${COLORS[k]}" stroke-width="2.6" marker-end="url(#ah-${k})"${dashed ? ' stroke-dasharray="7 5"' : ""}/>`);
    if (label) {
      // Anchor the label beyond the arrowhead, on the side the arrow points to (left arrows get it on their left…).
      const w = esc(label).length * 10 + 6, h = 22;
      const x = dx < -0.3 ? end.x - 14 - w : dx > 0.3 ? end.x + 14 : end.x - w / 2;
      const y = dy > 0.3 ? end.y + 10 : dy < -0.3 ? end.y - 14 - h : end.y - h / 2;
      labels.push({ x, y, w, h, str: esc(label), color: COLORS[k], dx, dy });
    }
  };
  const Lw = 140, minLen = 48;
  const facts: string[] = [`slope at ${f(th)}° (drawn to that angle)`];
  if (forces.includes("weight")) { arrow("weight", G, 0, 1, Lw, L.weight ?? "mg"); facts.push("weight straight down"); }
  if (forces.includes("components")) {
    arrow("components", G, -u.x, -u.y, Math.max(minLen, Lw * s), L.components ? undefined : "mg sin θ", true);
    arrow("components", G, -n.x, -n.y, Math.max(minLen, Lw * c), L.components ? undefined : "mg cos θ", true);
    facts.push("weight components: mg sin θ down the slope, mg cos θ into the surface (dashed)");
  }
  if (forces.includes("normal")) { arrow("normal", G, n.x, n.y, Math.max(minLen, Lw * c), L.normal ?? "N"); facts.push("normal force perpendicular to the surface"); }
  if (forces.includes("applied")) { const d = motion === "down" ? -1 : 1; arrow("applied", G, u.x * d, u.y * d, 120, L.applied ?? "F"); facts.push(`driving/applied force along the slope (${motion === "down" ? "down" : "up"})`); }
  // Friction acts at the contact surface, so it is drawn from there — also keeps it clear of mg sin θ.
  if (forces.includes("friction") && motion !== "none") { const d = motion === "up" ? -1 : 1; arrow("friction", { x: P.x + n.x * 6, y: P.y + n.y * 6 }, u.x * d, u.y * d, 90, L.friction ?? "f"); facts.push(`friction along the slope at the contact surface, ${motion === "up" ? "down" : "up"} (against the motion)`); }

  // Nudge labels apart: push each one along its own arrow direction (then sideways) until it overlaps nothing placed so far.
  const placed: Lab[] = [{ x: A.x + r + 6, y: A.y - r * s / 2 - 16, w: 50, h: 22, str: "", color: "", dx: 0, dy: 0 }];
  const hit = (a: Lab, b: Lab) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const lab of labels) {
    const perp = { x: -lab.dy, y: lab.dx };
    for (let k = 0; k < 24 && placed.some((p) => hit(lab, p)); k++) {
      const side = k % 2 ? 1 : -1;
      lab.x += lab.dx * 6 + perp.x * 8 * side * (k + 1) * 0.5;
      lab.y += lab.dy * 6 + perp.y * 8 * side * (k + 1) * 0.5;
    }
    placed.push(lab);
    parts.push(text(lab.x + 3, lab.y + 16, lab.str, `fill="${lab.color}"`));
  }

  // Crop to what is drawn (with a margin), so the figure has no dead space.
  const xs = [A.x, B.x, C.x, ...labels.flatMap((l) => [l.x, l.x + l.w])], ys = [A.y, C.y, G.y - Lw, ...labels.flatMap((l) => [l.y, l.y + l.h])];
  const minX = Math.max(0, Math.min(...xs) - 24), minY = Math.max(0, Math.min(...ys) - 24);
  const maxX = Math.max(...xs) + 24, maxY = Math.max(...ys) + 24;
  return { svg: `<svg viewBox="${f(minX)} ${f(minY)} ${f(maxX - minX)} ${f(maxY - minY)}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`, facts: facts.join("; ") };
}
