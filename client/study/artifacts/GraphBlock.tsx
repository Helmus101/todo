import { useMemo, useState } from "react";
import type { GraphSpec } from "../../../shared/types.ts";
import { compileExpr } from "../../../shared/mathExpr.ts";

const W = 560, H = 340, PAD = { l: 44, r: 16, t: 14, b: 30 };
const COLOR: Record<string, string> = { blue: "#2563EB", red: "#DC2626", green: "#16A34A", orange: "#EA580C", purple: "#9333EA", ink: "var(--ink)" };

function niceStep(span: number, target = 6): number {
  const raw = span / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}
const fmt = (v: number) => (Math.abs(v) < 1e-9 ? "0" : Math.abs(v) >= 1000 || Math.abs(v) < 0.01 ? v.toExponential(1) : String(Math.round(v * 100) / 100));

/** A live function plot (GRAPH_ON_BOARD): grid + axes + curves, sliders that re-draw instantly, and a hover
 *  readout of each curve's value. Pure SVG, expressions compiled by shared/mathExpr.ts — nothing is eval'd. */
export function GraphBlock({ spec }: { spec: GraphSpec }) {
  const [vals, setVals] = useState<Record<string, number>>(() => Object.fromEntries((spec.params || []).map((p) => [p.name, p.value])));
  const [hoverX, setHoverX] = useState<number | null>(null);
  const names = useMemo(() => ["x", ...(spec.params || []).map((p) => p.name)], [spec]);
  const compiled = useMemo(() => spec.fns.map((f) => { const c = compileExpr(f.expr, names); return "fn" in c ? c.fn : null; }), [spec, names]);

  // y-window: explicit when given; otherwise fitted ONCE over the whole slider range (so dragging doesn't make
  // the axes jump), clipped to the 3rd–97th percentile so an asymptote can't flatten everything else.
  const [ymin, ymax] = useMemo((): [number, number] => {
    if (spec.ymin != null && spec.ymax != null) return [spec.ymin, spec.ymax];
    const ys: number[] = [];
    const combos: Record<string, number>[] = [{}];
    for (const p of spec.params || []) {
      const next: Record<string, number>[] = [];
      for (const c of combos) for (const v of [p.min, (p.min + p.max) / 2, p.max]) next.push({ ...c, [p.name]: v });
      combos.splice(0, combos.length, ...next);
    }
    for (const fn of compiled) {
      if (!fn) continue;
      for (const c of combos) for (let i = 0; i <= 120; i++) { const y = fn({ ...c, x: spec.xmin + ((spec.xmax - spec.xmin) * i) / 120 }); if (Number.isFinite(y)) ys.push(y); }
    }
    for (const pt of spec.points || []) ys.push(pt.y);
    if (!ys.length) return [-5, 5];
    ys.sort((a, b) => a - b);
    let lo = ys[Math.floor(ys.length * 0.03)], hi = ys[Math.ceil(ys.length * 0.97) - 1];
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.1;
    return [lo - pad, hi + pad];
  }, [spec, compiled]);

  const sx = (x: number) => PAD.l + ((x - spec.xmin) / (spec.xmax - spec.xmin)) * (W - PAD.l - PAD.r);
  const sy = (y: number) => H - PAD.b - ((y - ymin) / (ymax - ymin)) * (H - PAD.t - PAD.b);
  const xs = niceStep(spec.xmax - spec.xmin), ys2 = niceStep(ymax - ymin);
  const xticks: number[] = []; for (let v = Math.ceil(spec.xmin / xs) * xs; v <= spec.xmax + 1e-9; v += xs) xticks.push(v);
  const yticks: number[] = []; for (let v = Math.ceil(ymin / ys2) * ys2; v <= ymax + 1e-9; v += ys2) yticks.push(v);

  const paths = compiled.map((fn) => {
    if (!fn) return "";
    const N = 240; let d = "", pen = false, prev: number | null = null;
    const span = ymax - ymin;
    for (let i = 0; i <= N; i++) {
      const x = spec.xmin + ((spec.xmax - spec.xmin) * i) / N, y = fn({ ...vals, x });
      const ok = Number.isFinite(y) && y > ymin - span && y < ymax + span && (prev === null || Math.abs(y - prev) < span * 1.5);
      if (!ok) { pen = false; prev = Number.isFinite(y) ? y : null; continue; }
      d += `${pen ? "L" : "M"}${sx(x).toFixed(1)} ${sy(y).toFixed(1)} `; pen = true; prev = y;
    }
    return d;
  });

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    if (px < PAD.l || px > W - PAD.r) { setHoverX(null); return; }
    setHoverX(spec.xmin + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (spec.xmax - spec.xmin));
  };

  return (
    <div className="sm-graph">
      <svg viewBox={`0 0 ${W} ${H}`} className="sm-graph-svg" role="img" aria-label="graph" onPointerMove={onMove} onPointerLeave={() => setHoverX(null)}>
        {xticks.map((v) => <g key={`x${v}`}><line x1={sx(v)} x2={sx(v)} y1={PAD.t} y2={H - PAD.b} className="sm-graph-grid" /><text x={sx(v)} y={H - PAD.b + 16} className="sm-graph-tick" textAnchor="middle">{fmt(v)}</text></g>)}
        {yticks.map((v) => <g key={`y${v}`}><line x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} className="sm-graph-grid" /><text x={PAD.l - 6} y={sy(v) + 4} className="sm-graph-tick" textAnchor="end">{fmt(v)}</text></g>)}
        {spec.xmin < 0 && spec.xmax > 0 && <line x1={sx(0)} x2={sx(0)} y1={PAD.t} y2={H - PAD.b} className="sm-graph-axis" />}
        {ymin < 0 && ymax > 0 && <line x1={PAD.l} x2={W - PAD.r} y1={sy(0)} y2={sy(0)} className="sm-graph-axis" />}
        <clipPath id="sm-graph-clip"><rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} /></clipPath>
        <g clipPath="url(#sm-graph-clip)">
          {paths.map((d, i) => d && <path key={i} d={d} fill="none" stroke={COLOR[spec.fns[i].color || "blue"]} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={spec.fns[i].dashed ? "6 5" : undefined} />)}
          {spec.connect && spec.points && spec.points.length > 1 && <polyline points={spec.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")} fill="none" stroke="var(--ink-2)" strokeWidth={1.6} />}
          {hoverX !== null && <line x1={sx(hoverX)} x2={sx(hoverX)} y1={PAD.t} y2={H - PAD.b} className="sm-graph-hover" />}
        </g>
        {(spec.points || []).map((p, i) => <g key={i}><circle cx={sx(p.x)} cy={sy(p.y)} r={4.5} className="sm-graph-pt" />{p.label && <text x={sx(p.x) + 8} y={sy(p.y) - 8} className="sm-graph-ptlabel">{p.label}</text>}</g>)}
        {spec.xLabel && <text x={W - PAD.r} y={H - 4} className="sm-graph-axislabel" textAnchor="end">{spec.xLabel}</text>}
        {spec.yLabel && <text x={PAD.l + 6} y={PAD.t + 10} className="sm-graph-axislabel">{spec.yLabel}</text>}
      </svg>
      <div className="sm-graph-legend">
        {spec.fns.map((f, i) => {
          const fn = compiled[i];
          const y = hoverX !== null && fn ? fn({ ...vals, x: hoverX }) : null;
          return (
            <span key={i} className="sm-graph-leg"><i style={{ background: COLOR[f.color || "blue"] }} />{f.label || `y = ${f.expr}`}
              {hoverX !== null && <em> · x={fmt(hoverX)}, y={y !== null && Number.isFinite(y) ? fmt(y) : "—"}</em>}</span>
          );
        })}
      </div>
      {(spec.params || []).length > 0 && (
        <div className="sm-graph-sliders">
          {spec.params!.map((p) => (
            <label key={p.name} className="sm-graph-slider">
              <span>{p.label || p.name} = <b>{fmt(vals[p.name] ?? p.value)}</b></span>
              <input type="range" min={p.min} max={p.max} step={p.step || (p.max - p.min) / 40} value={vals[p.name] ?? p.value}
                onChange={(e) => setVals((v) => ({ ...v, [p.name]: Number(e.target.value) }))} />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
