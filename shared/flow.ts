// Auto-laid-out diagrams (FLOW_ON_BOARD): the tutor names the nodes and arrows, THIS file does the layout — no
// coordinates for a model to get wrong, no KaTeX, just boxes and arrows that never overlap. Three kinds:
//   flow     layered flowchart / cause→effect chain / tree (top-down or left-to-right), cycles tolerated
//   cycle    a loop of stages (water cycle, Krebs cycle, business cycle) laid out on a circle
//   timeline events in order along a line, alternating above/below
// Pure and dependency-free: the server validates with normalizeFlow, the client renders the result of layoutFlow.

export type FlowShape = "box" | "round" | "diamond" | "circle";
export interface FlowNode { id: string; label: string; note?: string; shape?: FlowShape }
export interface FlowEdge { from: string; to: string; label?: string }
export interface FlowSpec { type: "flow" | "cycle" | "timeline"; direction: "TD" | "LR"; nodes: FlowNode[]; edges: FlowEdge[] }

const str = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function normalizeFlow(input: any): { flow: FlowSpec } | { error: string } {
  const type = ["flow", "cycle", "timeline"].includes(input?.type) ? input.type : "flow";
  const rawNodes = Array.isArray(input?.nodes) ? input.nodes : [];
  const nodes: FlowNode[] = [];
  const seen = new Set<string>();
  for (const n of rawNodes.slice(0, 14)) {
    const label = str(n?.label ?? n?.text, 70);
    const id = str(n?.id ?? label, 30);
    if (!label || !id || seen.has(id)) continue;
    seen.add(id);
    const shape: FlowShape = ["box", "round", "diamond", "circle"].includes(n?.shape) ? n.shape : "box";
    nodes.push({ id, label, ...(n?.note ? { note: str(n.note, 80) } : {}), shape });
  }
  if (nodes.length < 2) return { error: "ERROR: a diagram needs at least 2 nodes like {id, label}." };
  let edges: FlowEdge[] = (Array.isArray(input?.edges) ? input.edges : []).slice(0, 30)
    .map((e: any) => ({ from: str(e?.from, 30), to: str(e?.to, 30), ...(e?.label ? { label: str(e.label, 36) } : {}) }))
    .filter((e: FlowEdge) => seen.has(e.from) && seen.has(e.to) && e.from !== e.to);
  // De-duplicate identical arrows.
  edges = edges.filter((e, i) => edges.findIndex((x) => x.from === e.from && x.to === e.to) === i);
  if (type === "cycle") {
    if (nodes.length < 3) return { error: "ERROR: a cycle needs at least 3 stages." };
    if (!edges.length) edges = nodes.map((n, i) => ({ from: n.id, to: nodes[(i + 1) % nodes.length].id }));
  }
  if (type === "timeline" && !edges.length) edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
  if (type === "flow" && !edges.length) return { error: "ERROR: a flow diagram needs `edges` like {from, to, label?} — otherwise it's just a list." };
  return { flow: { type, direction: input?.direction === "LR" ? "LR" : "TD", nodes, edges } };
}

// ── layout ───────────────────────────────────────────────────────────────────────────────────────────────────────
const CHAR_W = 8.2, LINE_H = 18, PAD_X = 14, PAD_Y = 9;

export interface PlacedNode { id: string; x: number; y: number; w: number; h: number; lines: string[]; noteLines: string[]; shape: FlowShape }
export interface PlacedEdge { from: string; to: string; d: string; label?: string; lx: number; ly: number }
export interface FlowLayout { width: number; height: number; nodes: PlacedNode[]; edges: PlacedEdge[] }

export function wrapLabel(text: string, maxChars: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > maxChars) { lines.push(cur); cur = w; } else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

function size(n: FlowNode, maxChars: number): { w: number; h: number; lines: string[]; noteLines: string[] } {
  const lines = wrapLabel(n.label, maxChars);
  const noteLines = n.note ? wrapLabel(n.note, maxChars + 4) : [];
  const textW = Math.max(...lines.map((l) => l.length), ...noteLines.map((l) => Math.round(l.length * 0.85))) * CHAR_W;
  let w = Math.max(72, textW + PAD_X * 2), h = Math.max(38, lines.length * LINE_H + noteLines.length * 15 + PAD_Y * 2);
  if (n.shape === "diamond") { w = w * 1.45; h = h * 1.5; }
  if (n.shape === "circle") { const d = Math.max(w, h) * 1.1; w = d; h = d; }
  return { w: Math.round(w), h: Math.round(h), lines, noteLines };
}

/** Longest-path layering that tolerates cycles (edges that close a loop are treated as back edges). */
function layerOf(spec: FlowSpec): Map<string, number> {
  const out = new Map<string, string[]>(), state = new Map<string, number>(), back = new Set<string>();
  for (const n of spec.nodes) out.set(n.id, []);
  for (const e of spec.edges) out.get(e.from)!.push(e.to);
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const v of out.get(u)!) {
      if (state.get(v) === 1) back.add(`${u}>${v}`);
      else if (!state.get(v)) dfs(v);
    }
    state.set(u, 2);
  };
  const hasIn = new Set(spec.edges.map((e) => e.to));
  for (const n of spec.nodes) if (!hasIn.has(n.id)) dfs(n.id);
  for (const n of spec.nodes) if (!state.get(n.id)) dfs(n.id);
  const layer = new Map<string, number>(spec.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < spec.nodes.length; pass++) {
    let changed = false;
    for (const e of spec.edges) {
      if (back.has(`${e.from}>${e.to}`)) continue;
      const want = (layer.get(e.from) ?? 0) + 1;
      if (want > (layer.get(e.to) ?? 0)) { layer.set(e.to, want); changed = true; }
    }
    if (!changed) break;
  }
  return layer;
}

function bez(x1: number, y1: number, x2: number, y2: number, vertical: boolean): { d: string; mx: number; my: number } {
  const k = vertical ? Math.max(24, Math.abs(y2 - y1) / 2) : Math.max(24, Math.abs(x2 - x1) / 2);
  const c1x = vertical ? x1 : x1 + k, c1y = vertical ? y1 + k : y1, c2x = vertical ? x2 : x2 - k, c2y = vertical ? y2 - k : y2;
  const mx = (x1 + 3 * c1x + 3 * c2x + x2) / 8, my = (y1 + 3 * c1y + 3 * c2y + y2) / 8;
  return { d: `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`, mx, my };
}

export function layoutFlow(spec: FlowSpec): FlowLayout {
  if (spec.type === "cycle") return layoutCycle(spec);
  if (spec.type === "timeline") return layoutTimeline(spec);
  const LR = spec.direction === "LR";
  const dims = new Map(spec.nodes.map((n) => [n.id, size(n, LR ? 18 : 24)]));
  const layer = layerOf(spec);
  const layers: string[][] = [];
  for (const n of spec.nodes) { const l = layer.get(n.id)!; (layers[l] ||= []).push(n.id); }
  for (let i = 0; i < layers.length; i++) layers[i] ||= [];
  // Order within a layer by the average position of neighbours in the previous layer (two sweeps).
  const pos = new Map<string, number>();
  layers.forEach((ids) => ids.forEach((id, i) => pos.set(id, i)));
  for (let sweep = 0; sweep < 3; sweep++) {
    for (let li = 1; li < layers.length; li++) {
      const bary = (id: string) => {
        const ps = spec.edges.filter((e) => e.to === id && layer.get(e.from)! < li).map((e) => pos.get(e.from)!);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : pos.get(id)!;
      };
      layers[li].sort((a, b) => bary(a) - bary(b));
      layers[li].forEach((id, i) => pos.set(id, i));
    }
  }
  const GAP_PRIMARY = 64, GAP_SECOND = 30;
  const prim = (id: string) => (LR ? dims.get(id)!.w : dims.get(id)!.h);
  const sec = (id: string) => (LR ? dims.get(id)!.h : dims.get(id)!.w);
  const layerPrim = layers.map((ids) => Math.max(0, ...ids.map(prim)));
  const layerSec = layers.map((ids) => ids.reduce((s, id) => s + sec(id), 0) + Math.max(0, ids.length - 1) * GAP_SECOND);
  const maxSec = Math.max(...layerSec, 0);
  const placed = new Map<string, PlacedNode>();
  let cursor = 20;
  layers.forEach((ids, li) => {
    let s = 20 + (maxSec - layerSec[li]) / 2;
    for (const id of ids) {
      const d = dims.get(id)!, n = spec.nodes.find((x) => x.id === id)!;
      const p = cursor + (layerPrim[li] - prim(id)) / 2;
      placed.set(id, { id, x: Math.round(LR ? p : s), y: Math.round(LR ? s : p), w: d.w, h: d.h, lines: d.lines, noteLines: d.noteLines, shape: n.shape || "box" });
      s += sec(id) + GAP_SECOND;
    }
    cursor += layerPrim[li] + GAP_PRIMARY;
  });
  const width = Math.round(LR ? cursor - GAP_PRIMARY + 20 : maxSec + 40), height = Math.round(LR ? maxSec + 40 : cursor - GAP_PRIMARY + 20);
  const edges: PlacedEdge[] = [];
  const sideUsed = new Map<string, number>();
  for (const e of spec.edges) {
    const a = placed.get(e.from)!, b = placed.get(e.to)!;
    const forward = layer.get(e.to)! > layer.get(e.from)!;
    let d: string, lx: number, ly: number;
    if (forward) {
      const r = LR ? bez(a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2, false) : bez(a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y, true);
      d = r.d; lx = r.mx; ly = r.my;
    } else {
      // A back edge / same-layer edge loops round the outside so it never cuts across other boxes.
      const k = (sideUsed.get(e.from) || 0) + 1; sideUsed.set(e.from, k);
      const off = 36 + 14 * k;
      if (LR) {
        const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y + b.h, yy = Math.max(y1, y2) + off;
        d = `M ${x1} ${y1} C ${x1} ${yy}, ${x2} ${yy}, ${x2} ${y2}`; lx = (x1 + x2) / 2; ly = yy - 6;
      } else {
        const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x + b.w, y2 = b.y + b.h / 2, xx = Math.max(x1, x2) + off;
        d = `M ${x1} ${y1} C ${xx} ${y1}, ${xx} ${y2}, ${x2} ${y2}`; lx = xx - 4; ly = (y1 + y2) / 2;
      }
    }
    edges.push({ from: e.from, to: e.to, d, label: e.label, lx: Math.round(lx), ly: Math.round(ly) });
  }
  const extra = edges.some((e) => !(layer.get(e.to)! > layer.get(e.from)!)) ? 70 : 0;
  return { width: width + (LR ? 0 : extra), height: height + (LR ? extra : 0), nodes: [...placed.values()], edges };
}

function layoutCycle(spec: FlowSpec): FlowLayout {
  const n = spec.nodes.length;
  const dims = spec.nodes.map((nd) => size(nd, 16));
  const maxW = Math.max(...dims.map((d) => d.w)), maxH = Math.max(...dims.map((d) => d.h));
  const R = Math.max(110, ((maxW + 30) * n) / (2 * Math.PI), (maxH + 24) * n / (2 * Math.PI) + 40);
  const cx = R + maxW / 2 + 20, cy = R + maxH / 2 + 20;
  const placed = new Map<string, PlacedNode>();
  spec.nodes.forEach((nd, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n, d = dims[i];
    placed.set(nd.id, { id: nd.id, x: Math.round(cx + R * Math.cos(a) - d.w / 2), y: Math.round(cy + R * Math.sin(a) - d.h / 2), w: d.w, h: d.h, lines: d.lines, noteLines: d.noteLines, shape: nd.shape || "round" });
  });
  const edges: PlacedEdge[] = spec.edges.map((e) => {
    const a = placed.get(e.from)!, b = placed.get(e.to)!;
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
    // trim the straight line to each box's edge, then bow it outward from the centre so the loop reads as a ring
    const trim = (px: number, py: number, qx: number, qy: number, w: number, h: number) => {
      const dx = qx - px, dy = qy - py, t = Math.min(w / 2 / Math.max(Math.abs(dx), 1e-6), h / 2 / Math.max(Math.abs(dy), 1e-6));
      return { x: px + dx * Math.min(1, t) * 1.04, y: py + dy * Math.min(1, t) * 1.04 };
    };
    const s = trim(ax, ay, bx, by, a.w, a.h), t = trim(bx, by, ax, ay, b.w, b.h);
    const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2, vx = mx - cx, vy = my - cy, vl = Math.hypot(vx, vy) || 1;
    const bow = 0.28 * Math.hypot(t.x - s.x, t.y - s.y);
    const qx = mx + (vx / vl) * bow, qy = my + (vy / vl) * bow;
    return { from: e.from, to: e.to, d: `M ${Math.round(s.x)} ${Math.round(s.y)} Q ${Math.round(qx)} ${Math.round(qy)} ${Math.round(t.x)} ${Math.round(t.y)}`, label: e.label, lx: Math.round((mx + qx) / 2 + (vx / vl) * 8), ly: Math.round((my + qy) / 2 + (vy / vl) * 8) };
  });
  return { width: Math.round(cx * 2), height: Math.round(cy * 2), nodes: [...placed.values()], edges };
}

function layoutTimeline(spec: FlowSpec): FlowLayout {
  const dims = spec.nodes.map((nd) => size({ ...nd, shape: "box" }, 16));
  const gap = 24;
  let x = 24;
  const lineY = Math.max(...dims.map((d) => d.h)) + 40;
  const placed: PlacedNode[] = [];
  const edges: PlacedEdge[] = [];
  spec.nodes.forEach((nd, i) => {
    const d = dims[i], above = i % 2 === 0;
    const px = x, py = above ? lineY - 22 - d.h : lineY + 22;
    placed.push({ id: nd.id, x: px, y: py, w: d.w, h: d.h, lines: d.lines, noteLines: d.noteLines, shape: "box" });
    // a stem from the box to its tick on the spine
    edges.push({ from: nd.id, to: nd.id, d: `M ${px + d.w / 2} ${above ? py + d.h : py} L ${px + d.w / 2} ${lineY}`, lx: 0, ly: 0 });
    x += Math.max(d.w * 0.62, 70) + gap;
  });
  const width = Math.round(Math.max(...placed.map((p) => p.x + p.w)) + 24);
  edges.push({ from: "", to: "", d: `M 10 ${lineY} L ${width - 10} ${lineY}`, lx: 0, ly: 0 });
  return { width, height: Math.round(Math.max(...placed.map((p) => p.y + p.h)) + 24), nodes: placed, edges };
}
