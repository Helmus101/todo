/**
 * Smooth ink rendering — makes freehand drawing feel like writing on paper, not dragging pixels.
 *
 * Two techniques that matter most for the "pen on paper" feel:
 *  1. Quadratic Bézier midpoint smoothing — instead of jagged lineTo segments, each new point draws a
 *     smooth curve through the midpoint of the previous pair, eliminating the stair-step jaggedness of
 *     raw polyline drawing at any speed.
 *  2. Velocity-based variable width — slower movement produces a thicker stroke (like pressing harder
 *     with a pen), faster movement produces a thinner one. Round line caps blend the width transitions
 *     so joins are invisible.
 *
 * Strokes are stored as point arrays (with timestamps for velocity) and can be re-rendered in full —
 * needed for undo (pop + redraw) and for restoring persisted state.
 */

export interface InkPoint {
  x: number;
  y: number;
  t: number; // performance.now() at capture — for velocity
}

export interface InkStroke {
  points: InkPoint[];
  color: string;
  baseWidth: number;
  /** Eraser strokes store their color as the paper background and are wider — same data, just rendered
   *  differently. The renderer doesn't special-case them; the caller sets color + width accordingly. */
}

const MAX_VEL = 45; // px/frame above which the stroke is at its thinnest
const WIDTH_MIN = 0.55; // fastest → 55% of base width
const WIDTH_MAX = 1.45; // slowest → 145% of base width

/** Width for a given instantaneous velocity (px between consecutive points). Slower = thicker. */
function widthForVelocity(vel: number, baseWidth: number): number {
  const clamped = Math.min(vel / MAX_VEL, 1);
  const factor = WIDTH_MAX - clamped * (WIDTH_MAX - WIDTH_MIN);
  return baseWidth * factor;
}

/** Distance between two points. */
function dist(a: InkPoint, b: InkPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Midpoint of two points. */
function mid(a: InkPoint, b: InkPoint): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Draw one smooth incremental segment as a new point arrives. Call this on every pointermove while
 * drawing. Accumulates into the stroke's point buffer and renders just the new segment.
 */
export function inkExtend(
  ctx: CanvasRenderingContext2D,
  stroke: InkStroke,
  point: InkPoint,
): void {
  const pts = stroke.points;
  pts.push(point);

  ctx.strokeStyle = stroke.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (pts.length < 3) {
    // Not enough points for Bézier yet — draw a straight segment (round-capped, so it looks like a dot
    // for a single tap and a short smooth line for two).
    if (pts.length === 2) {
      const vel = dist(pts[0], pts[1]);
      ctx.beginPath();
      ctx.lineWidth = widthForVelocity(vel, stroke.baseWidth);
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
    }
    return;
  }

  const n = pts.length;
  const p0 = pts[n - 3];
  const p1 = pts[n - 2];
  const p2 = pts[n - 1];
  const m01 = mid(p0, p1);
  const m12 = mid(p1, p2);
  const vel = dist(p1, p2);

  ctx.beginPath();
  ctx.lineWidth = widthForVelocity(vel, stroke.baseWidth);
  ctx.moveTo(m01.x, m01.y);
  ctx.quadraticCurveTo(p1.x, p1.y, m12.x, m12.y);
  ctx.stroke();
}

/**
 * Re-render a complete stroke from its stored points. Used after undo (pop a stroke, redraw the rest)
 * and when restoring persisted state. Renders the full Bézier-smoothed path in one pass.
 */
export function renderStroke(ctx: CanvasRenderingContext2D, stroke: InkStroke): void {
  const pts = stroke.points;
  if (pts.length === 0) return;

  ctx.strokeStyle = stroke.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (pts.length < 3) {
    if (pts.length === 2) {
      ctx.beginPath();
      ctx.lineWidth = widthForVelocity(dist(pts[0], pts[1]), stroke.baseWidth);
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
    } else if (pts.length === 1) {
      // Single point — render as a dot
      ctx.beginPath();
      ctx.fillStyle = stroke.color;
      ctx.arc(pts[0].x, pts[0].y, stroke.baseWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  // First segment: from p0 to midpoint(p0,p1) — straight, with the starting width
  ctx.beginPath();
  ctx.lineWidth = widthForVelocity(dist(pts[0], pts[1]), stroke.baseWidth);
  ctx.moveTo(pts[0].x, pts[0].y);
  ctx.lineTo(mid(pts[0], pts[1]).x, mid(pts[0], pts[1]).y);
  ctx.stroke();

  // Middle segments: Bézier from midpoint(p[i-1],p[i]) to midpoint(p[i],p[i+1]) with p[i] as control
  for (let i = 1; i < pts.length - 1; i++) {
    const m0 = mid(pts[i - 1], pts[i]);
    const m1 = mid(pts[i], pts[i + 1]);
    const vel = dist(pts[i], pts[i + 1]);
    ctx.beginPath();
    ctx.lineWidth = widthForVelocity(vel, stroke.baseWidth);
    ctx.moveTo(m0.x, m0.y);
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, m1.x, m1.y);
    ctx.stroke();
  }

  // Last segment: from midpoint(p[n-2],p[n-1]) to p[n-1]
  const last = pts.length - 1;
  ctx.beginPath();
  ctx.lineWidth = widthForVelocity(dist(pts[last - 1], pts[last]), stroke.baseWidth);
  ctx.moveTo(mid(pts[last - 1], pts[last]).x, mid(pts[last - 1], pts[last]).y);
  ctx.lineTo(pts[last].x, pts[last].y);
  ctx.stroke();
}

/** Re-render all strokes onto a cleared canvas. */
export function renderAllStrokes(ctx: CanvasRenderingContext2D, strokes: InkStroke[]): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const s of strokes) renderStroke(ctx, s);
}

/** Create a new stroke starting at the given point. */
export function startStroke(point: InkPoint, color: string, baseWidth: number): InkStroke {
  return { points: [point], color, baseWidth };
}
