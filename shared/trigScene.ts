// Angle-of-elevation / angle-of-depression scenes (TRIG_SCENE_ON_BOARD). A model drawing these free-hand keeps getting the
// geometry wrong (which angle sits where, alternate angles, which boat is nearer) — so the app COMPUTES the scene: it
// places the tower and observers to scale from the real numbers, marks the angles in the right places (the depression at
// the top AND its equal elevation at the ground), and returns an SVG. Only GIVEN values are labelled; unknowns stay as
// letters, and the (hidden) solution is used purely to place things to scale. Pure — the server calls it, tests cover it.

export interface ObserverIn { name?: string; angle: number }
export interface TrigSceneIn {
  mode?: "depression" | "elevation";
  observers: ObserverIn[];            // 1 or 2 points on the ground, in a line with the base of the tower
  separation?: number;                // distance between the two observers (when 2)
  towerHeight?: number;               // the KNOWN part of the height (e.g. the 470 m cliff)
  unknownTop?: string;                // letter for an unknown extra height on top (e.g. "h"); omit if towerHeight is the whole height
  distance?: number;                  // 1 observer: distance to the base, if given
  baseName?: string; topName?: string; units?: string;
}

const rad = (d: number) => (d * Math.PI) / 180;
const f = (n: number) => Math.round(n * 10) / 10;
const esc = (s: string) => s.replace(/[<>&"]/g, "");

export function buildTrigScene(input: TrigSceneIn): { svg: string } | { error: string } {
  const mode = input.mode === "elevation" ? "elevation" : "depression";
  const units = esc(input.units || "m").slice(0, 6);
  const B = esc(input.baseName || "B").slice(0, 3), T = esc(input.topName || "T").slice(0, 3);
  const obs = (input.observers || []).slice(0, 2).map((o, i) => ({ name: esc(o.name || (i ? "K" : "J")).slice(0, 3), angle: Number(o.angle) }));
  if (!obs.length || obs.some((o) => !(o.angle > 0 && o.angle < 90))) return { error: "ERROR: observers need angles strictly between 0° and 90°." };
  if (obs.length === 2 && Math.abs(obs[0].angle - obs[1].angle) < 1) return { error: "ERROR: the two angles must differ." };
  const knownH = Number.isFinite(Number(input.towerHeight)) && Number(input.towerHeight) > 0 ? Number(input.towerHeight) : undefined;
  const sep = Number.isFinite(Number(input.separation)) && Number(input.separation) > 0 ? Number(input.separation) : undefined;

  // ── place the points to scale (world units, y up, base at x = 0) ──
  // each observer i sits at distance d_i from the base with tan(angle_i) = Ht / d_i
  let Ht: number; let dists: number[];
  if (obs.length === 2) {
    const [nearI, farI] = obs[0].angle > obs[1].angle ? [0, 1] : [1, 0]; // bigger angle = nearer
    const tn = Math.tan(rad(obs[nearI].angle)), tf = Math.tan(rad(obs[farI].angle));
    const s = sep ?? 1;
    const x = (s * tf) / (tn - tf);          // distance base → nearer observer
    Ht = x * tn;
    dists = [0, 0]; dists[nearI] = x; dists[farI] = x + s;
  } else {
    const t = Math.tan(rad(obs[0].angle));
    const d = Number(input.distance) > 0 ? Number(input.distance) : undefined;
    Ht = d ? d * t : knownH ? (input.unknownTop ? knownH * 1.3 : knownH) : 100;
    dists = [Ht / t];
  }
  const cliff = knownH && input.unknownTop ? Math.min(knownH, Ht * 0.9) : undefined; // lower, known part when there is an unknown top
  const farthest = Math.max(...dists);

  // ── world → canvas (uniform scale, so angles look like their size) ──
  const W = 800, H = 460, mL = 70, mR = 130, mT = 56, mB = 84;
  const sc = Math.min((W - mL - mR) / farthest, (H - mT - mB) / Ht);
  const bx = mL + farthest * sc;            // base x
  const gy = H - mB;                        // ground y
  const px = (d: number) => bx - d * sc;    // observer x at distance d
  const ty = gy - Ht * sc;                  // top y
  const parts: string[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number, extra = "") => `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" ${/stroke="/.test(extra) ? "" : 'stroke="currentColor" '}${/stroke-width="/.test(extra) ? "" : 'stroke-width="2" '}${extra}/>`;
  const text = (x: number, y: number, s: string, extra = "") => `<text x="${f(x)}" y="${f(y)}" ${/font-size="/.test(extra) ? "" : 'font-size="18" '}${/fill="/.test(extra) ? "" : 'fill="currentColor" '}font-family="Inter, system-ui, sans-serif" ${extra}>${esc(s)}</text>`;
  const COLORS = ["#DC2626", "#2563EB"];

  // ground, tower
  parts.push(line(mL - 30, gy, bx + 40, gy));
  parts.push(line(bx, gy, bx, ty, 'stroke-width="3"'));
  parts.push(`<path d="M ${f(bx - 14)} ${f(gy)} L ${f(bx - 14)} ${f(gy - 14)} L ${f(bx)} ${f(gy - 14)}" fill="none" stroke="currentColor" stroke-width="1.5"/>`);
  if (cliff) {
    const cy = gy - cliff * sc;
    parts.push(`<rect x="${f(bx)}" y="${f(cy)}" width="26" height="${f(gy - cy)}" fill="currentColor" opacity="0.08" stroke="none"/>`);
    parts.push(line(bx, cy, bx + 26, cy, 'stroke-width="1.5"'));
    parts.push(text(bx + 34, (gy + cy) / 2 + 6, `${knownH} ${units}`));
    parts.push(line(bx, ty, bx, cy, 'stroke="#16A34A" stroke-width="5"'));
    parts.push(text(bx + 12, (cy + ty) / 2 + 6, input.unknownTop!, 'fill="#16A34A" font-style="italic"'));
  } else if (knownH) {
    parts.push(text(bx + 14, (gy + ty) / 2 + 6, `${knownH} ${units}`));
  } else if (input.unknownTop) {
    parts.push(text(bx + 14, (gy + ty) / 2 + 6, input.unknownTop, 'font-style="italic"'));
  }
  // observers: sightlines, arcs, labels
  const horizLeft = mode === "depression" ? mL - 10 : null;
  if (horizLeft !== null) parts.push(line(bx, ty, horizLeft, ty, 'stroke-dasharray="7 6" opacity="0.6"'));
  obs.forEach((o, i) => {
    const x = px(dists[i]), c = COLORS[i % 2], th = o.angle;
    parts.push(line(bx, ty, x, gy, `stroke="${c}"`));
    parts.push(`<circle cx="${f(x)}" cy="${f(gy)}" r="4.5" fill="${c}"/>`);
    parts.push(text(x - 6, gy + 28, o.name, `font-weight="600" fill="${c}"`));
    // elevation problems mark the angle at the observer; for depression the equal ground angle is the student's to find, so it is NOT drawn
    const a = rad(th);
    if (mode === "elevation") {
      const re = 38 + i * 16;
      const e0 = [x + re, gy], e1 = [x + re * Math.cos(a), gy - re * Math.sin(a)];
      parts.push(`<path d="M ${f(e0[0])} ${f(e0[1])} A ${re} ${re} 0 0 0 ${f(e1[0])} ${f(e1[1])}" fill="none" stroke="${c}" stroke-width="2"/>`);
      parts.push(text(x + (re + 12) * Math.cos(a / 2), gy - (re + 12) * Math.sin(a / 2) + 6, `${th}°`, `fill="${c}"`));
    }
    // angle at the top (depression) — between the horizontal and the sightline
    if (mode === "depression") {
      const rt = 70 + i * 64;
      const t0 = [bx - rt, ty], t1 = [bx - rt * Math.cos(a), ty + rt * Math.sin(a)];
      parts.push(`<path d="M ${f(t0[0])} ${f(t0[1])} A ${rt} ${rt} 0 0 0 ${f(t1[0])} ${f(t1[1])}" fill="none" stroke="${c}" stroke-width="2"/>`);
      // the label rides on the horizontal, just outside its arc, so it never sits on a sightline
      parts.push(text(bx - rt - 8, ty - 9, `${th}°`, `fill="${c}" font-weight="600" text-anchor="end"`));
    }
  });
  // distance between the observers / from the base
  if (obs.length === 2 && sep) {
    const xs = dists.map(px).sort((a, b) => a - b), yb = gy + 54;
    // bracket under the ground between the two observers
    parts.push(`<path d="M ${f(xs[0])} ${f(yb - 6)} L ${f(xs[0])} ${f(yb)} L ${f(xs[1])} ${f(yb)} L ${f(xs[1])} ${f(yb - 6)}" fill="none" stroke="currentColor" stroke-width="1.5"/>`);
    parts.push(text((xs[0] + xs[1]) / 2, yb + 22, `${sep} ${units}`, 'text-anchor="middle"'));
  }
  // point names
  parts.push(text(bx + 8, gy + 28, B, 'font-weight="600"'));
  parts.push(`<circle cx="${f(bx)}" cy="${f(ty)}" r="4.5" fill="currentColor"/>`);
  parts.push(text(bx + 10, ty - 8, T, 'font-weight="600"'));
  const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
  return { svg };
}

/** For the tests (and for sanity checks): the hidden solution used to place things to scale. */
export function solveTwoAngles(angleNear: number, angleFar: number, separation: number): { x: number; height: number } {
  const tn = Math.tan(rad(angleNear)), tf = Math.tan(rad(angleFar));
  const x = (separation * tf) / (tn - tf);
  return { x, height: x * tn };
}
