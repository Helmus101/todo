import { useMemo, useRef, useState } from "react";
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
function FunctionGraph({ spec }: { spec: GraphSpec }) {
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
      <Sliders params={spec.params} vals={vals} setVals={setVals} />
    </div>
  );
}


// ── bar chart / histogram ─────────────────────────────────────────────────────────────────────────────────
function Bars({ items, xLabel, yLabel, tickLabels }: { items: { label: string; value: number }[]; xLabel?: string; yLabel?: string; tickLabels?: string[] }) {
  const lo = Math.min(0, ...items.map((b) => b.value)), hi = Math.max(0, ...items.map((b) => b.value)) * 1.12 || 1;
  const sy = (v: number) => H - PAD.b - ((v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const step = niceStep(hi - lo), ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(v);
  const bw = (W - PAD.l - PAD.r) / items.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sm-graph-svg" role="img" aria-label="chart">
      {ticks.map((v) => <g key={v}><line x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} className="sm-graph-grid" /><text x={PAD.l - 6} y={sy(v) + 4} className="sm-graph-tick" textAnchor="end">{fmt(v)}</text></g>)}
      {items.map((b, i) => {
        const x = PAD.l + i * bw + bw * 0.12, w = bw * 0.76, y0 = sy(0), y1 = sy(b.value);
        return (
          <g key={i} className="sm-graph-bar">
            <rect x={x} y={Math.min(y0, y1)} width={w} height={Math.max(1, Math.abs(y0 - y1))} rx={3} fill={COLOR[["blue", "orange", "green", "purple", "red"][i % 5]]} opacity={0.88} />
            <text x={x + w / 2} y={Math.min(y0, y1) - 6} className="sm-graph-barval" textAnchor="middle">{fmt(b.value)}</text>
            <text x={x + w / 2} y={H - PAD.b + 16} className="sm-graph-tick" textAnchor="middle">{(tickLabels ? tickLabels[i] : b.label).slice(0, 12)}</text>
          </g>
        );
      })}
      <line x1={PAD.l} x2={W - PAD.r} y1={sy(0)} y2={sy(0)} className="sm-graph-axis" />
      {xLabel && <text x={W - PAD.r} y={H - 2} className="sm-graph-axislabel" textAnchor="end">{xLabel}</text>}
      {yLabel && <text x={PAD.l + 6} y={PAD.t + 10} className="sm-graph-axislabel">{yLabel}</text>}
    </svg>
  );
}

function Histogram({ spec }: { spec: GraphSpec }) {
  const data = spec.data || [];
  const items = useMemo(() => {
    const lo = Math.min(...data), hi = Math.max(...data);
    const n = spec.bins || Math.max(4, Math.min(20, Math.ceil(Math.log2(data.length) + 1)));
    const w = (hi - lo) / n, counts = new Array(n).fill(0);
    for (const v of data) counts[Math.min(n - 1, Math.floor((v - lo) / w))]++;
    return counts.map((c, i) => ({ label: `${fmt(lo + i * w)}`, value: c, range: `${fmt(lo + i * w)}–${fmt(lo + (i + 1) * w)}` }));
  }, [data, spec.bins]);
  return <Bars items={items} xLabel={spec.xLabel} yLabel={spec.yLabel || "count"} tickLabels={items.map((b) => b.label)} />;
}

// ── 3D surface z = f(x, y), drag to rotate ───────────────────────────────────────────────────────────────
function Surface({ spec }: { spec: GraphSpec }) {
  const [vals, setVals] = useState<Record<string, number>>(() => Object.fromEntries((spec.params || []).map((p) => [p.name, p.value])));
  const [view, setView] = useState({ az: 0.9, el: 0.6 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const names = useMemo(() => ["x", "y", ...(spec.params || []).map((p) => p.name)], [spec]);
  const fn = useMemo(() => { const c = compileExpr(spec.z || "0", names); return "fn" in c ? c.fn : null; }, [spec, names]);
  const N = 26;
  const x0 = spec.xmin, x1 = spec.xmax, y0 = spec.ymin ?? -1, y1 = spec.ymax ?? 1;
  // z-range fitted once across the slider range so dragging a slider visibly changes the SHAPE, not the scale.
  const [zlo, zhi] = useMemo((): [number, number] => {
    if (!fn) return [-1, 1];
    const combos: Record<string, number>[] = [{}];
    for (const p of spec.params || []) { const next: Record<string, number>[] = []; for (const c of combos) for (const v of [p.min, (p.min + p.max) / 2, p.max]) next.push({ ...c, [p.name]: v }); combos.splice(0, combos.length, ...next); }
    const zs: number[] = [];
    for (const c of combos) for (let i = 0; i <= 14; i++) for (let j = 0; j <= 14; j++) { const z = fn({ ...c, x: x0 + ((x1 - x0) * i) / 14, y: y0 + ((y1 - y0) * j) / 14 }); if (Number.isFinite(z)) zs.push(z); }
    if (!zs.length) return [-1, 1];
    zs.sort((a, b) => a - b);
    let lo = zs[Math.floor(zs.length * 0.01)], hi = zs[Math.ceil(zs.length * 0.99) - 1];
    if (lo === hi) { lo -= 1; hi += 1; }
    return [lo, hi];
  }, [fn, spec, x0, x1, y0, y1]);

  const { polys, base } = useMemo(() => {
    const { az, el } = view, ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
    const proj = (xn: number, yn: number, zn: number) => { const u = xn * ca - yn * sa, v = xn * sa + yn * ca; return { sx: W / 2 + u * 175, sy: H / 2 + 26 - (zn * ce * 1.0 - v * se) * 150, d: v * ce + zn * se }; };
    const pts: ({ sx: number; sy: number; d: number; z: number } | null)[][] = [];
    for (let i = 0; i <= N; i++) {
      const row: ({ sx: number; sy: number; d: number; z: number } | null)[] = [];
      for (let j = 0; j <= N; j++) {
        const x = x0 + ((x1 - x0) * i) / N, y = y0 + ((y1 - y0) * j) / N;
        const z = fn ? fn({ ...vals, x, y }) : NaN;
        if (!Number.isFinite(z)) { row.push(null); continue; }
        const zn = Math.max(-1.4, Math.min(1.4, ((z - zlo) / (zhi - zlo)) * 2 - 1));
        row.push({ ...proj((i / N) * 2 - 1, (j / N) * 2 - 1, zn), z: (zn + 1) / 2 });
      }
      pts.push(row);
    }
    const out: { d: number; pts: string; fill: string }[] = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const q = [pts[i][j], pts[i + 1][j], pts[i + 1][j + 1], pts[i][j + 1]];
      if (q.some((p) => !p)) continue;
      const t = q.reduce((a, p) => a + p!.z, 0) / 4;
      out.push({ d: q.reduce((a, p) => a + p!.d, 0) / 4, pts: q.map((p) => `${p!.sx.toFixed(1)},${p!.sy.toFixed(1)}`).join(" "), fill: `hsl(${Math.round(220 - t * 200)} 78% ${Math.round(44 + t * 14)}%)` });
    }
    out.sort((a, b) => b.d - a.d); // far to near (painter's algorithm)
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => proj(a, b, -1));
    return { polys: out, base: corners.map((c) => `${c.sx.toFixed(1)},${c.sy.toFixed(1)}`).join(" ") };
  }, [view, vals, fn, zlo, zhi, x0, x1, y0, y1]);

  return (
    <div className="sm-graph">
      <svg viewBox={`0 0 ${W} ${H}`} className="sm-graph-svg sm-graph-3d" role="img" aria-label="3D surface — drag to rotate"
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { const d = drag.current; if (!d) return; setView((v) => ({ az: v.az + (e.clientX - d.x) * 0.012, el: Math.max(0.1, Math.min(1.4, v.el + (e.clientY - d.y) * 0.008)) })); drag.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <polygon points={base} className="sm-graph-base" />
        {polys.map((p, i) => <polygon key={i} points={p.pts} fill={p.fill} className="sm-graph-quad" />)}
        <text x={W - PAD.r} y={H - 8} className="sm-graph-axislabel" textAnchor="end">drag to rotate · x∈[{fmt(x0)}, {fmt(x1)}], y∈[{fmt(y0)}, {fmt(y1)}], z∈[{fmt(zlo)}, {fmt(zhi)}]</text>
      </svg>
      <div className="sm-graph-legend"><span className="sm-graph-leg">z = {spec.z}</span></div>
      <Sliders params={spec.params} vals={vals} setVals={setVals} />
    </div>
  );
}

function Sliders({ params, vals, setVals }: { params?: GraphSpec["params"]; vals: Record<string, number>; setVals: (f: (v: Record<string, number>) => Record<string, number>) => void }) {
  if (!params?.length) return null;
  return (
    <div className="sm-graph-sliders">
      {params.map((p) => {
        const v = vals[p.name] ?? p.value;
        return (
          <label key={p.name} className="sm-graph-slider">
            <span>{p.label || p.name} = <b>{fmt(v)}</b></span>
            <input type="range" min={p.min} max={p.max} step={p.step || (p.max - p.min) / 40} value={v}
              style={{ ["--pct" as string]: `${((v - p.min) / (p.max - p.min)) * 100}%` }}
              onChange={(e) => setVals((o) => ({ ...o, [p.name]: Number(e.target.value) }))} />
          </label>
        );
      })}
    </div>
  );
}

/** Dispatch on the chart kind (GRAPH_ON_BOARD, server/claude.ts). */
export function GraphBlock({ spec }: { spec: GraphSpec }) {
  if (spec.kind === "bars" && spec.bars) return <div className="sm-graph"><Bars items={spec.bars} xLabel={spec.xLabel} yLabel={spec.yLabel} /></div>;
  if (spec.kind === "histogram" && spec.data) return <div className="sm-graph"><Histogram spec={spec} /></div>;
  if (spec.kind === "surface" && spec.z) return <Surface spec={spec} />;
  return <FunctionGraph spec={spec} />;
}
