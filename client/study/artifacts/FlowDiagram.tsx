import { useId, useMemo } from "react";
import type { FlowSpec } from "../../../shared/flow.ts";
import { layoutFlow } from "../../../shared/flow.ts";

/** An auto-laid-out diagram (FLOW_ON_BOARD): flowchart / cause-and-effect / cycle / timeline. Plain SVG text — no
 *  KaTeX, no model-supplied coordinates. Layout lives in shared/flow.ts. */
export function FlowDiagram({ spec }: { spec: FlowSpec }) {
  const uid = useId().replace(/:/g, "");
  const lay = useMemo(() => layoutFlow(spec), [spec]);
  const byId = new Map(lay.nodes.map((n) => [n.id, n]));
  const arrow = spec.type !== "timeline";
  return (
    <svg className="sm-flow" viewBox={`0 0 ${lay.width} ${lay.height}`} role="img" aria-label="diagram" style={{ width: "100%", maxWidth: Math.max(320, lay.width), height: "auto" }}>
      <defs>
        <marker id={`ah-${uid}`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M1,1 L8,4.5 L1,8 z" fill="currentColor" />
        </marker>
      </defs>
      {lay.edges.map((e, i) => (
        <path key={i} d={e.d} fill="none" stroke="currentColor" strokeWidth={e.from === e.to || !e.from ? 1.2 : 1.6} opacity={e.from === e.to || !e.from ? 0.45 : 0.85}
          markerEnd={arrow && e.from && e.from !== e.to ? `url(#ah-${uid})` : undefined} />
      ))}
      {lay.nodes.map((n) => {
        const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
        const shape = n.shape === "diamond"
          ? <polygon points={`${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}`} />
          : n.shape === "circle" ? <ellipse cx={cx} cy={cy} rx={n.w / 2} ry={n.h / 2} />
          : <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={n.shape === "round" ? n.h / 2 : 8} />;
        const total = n.lines.length * 18 + n.noteLines.length * 15;
        let y = cy - total / 2 + 13;
        return (
          <g key={n.id}>
            <g fill="var(--surface, #fff)" stroke="currentColor" strokeWidth={1.6}>{shape}</g>
            <text textAnchor="middle" fontSize={14} fill="currentColor" fontFamily="Inter, system-ui, sans-serif">
              {n.lines.map((l, i) => { const t = <tspan key={`l${i}`} x={cx} y={y} fontWeight={600}>{l}</tspan>; y += 18; return t; })}
              {n.noteLines.map((l, i) => { const t = <tspan key={`n${i}`} x={cx} y={y} fontSize={12} opacity={0.7}>{l}</tspan>; y += 15; return t; })}
            </text>
          </g>
        );
      })}
      {lay.edges.filter((e) => e.label).map((e, i) => {
        const w = Math.max(24, (e.label?.length || 0) * 6.6 + 12);
        return (
          <g key={`el${i}`}>
            <rect x={e.lx - w / 2} y={e.ly - 10} width={w} height={20} rx={5} fill="var(--bg, #fff)" opacity={0.92} />
            <text x={e.lx} y={e.ly + 4} textAnchor="middle" fontSize={12} fill="currentColor" fontFamily="Inter, system-ui, sans-serif">{e.label}</text>
          </g>
        );
      })}
      {void byId}
    </svg>
  );
}
