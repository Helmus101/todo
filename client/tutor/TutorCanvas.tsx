import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Pencil, Highlighter, Eraser, Type, Undo2, Redo2, Trash2, Hand, Send } from "lucide-react";
import { api } from "../api.ts";
import { useLang } from "../ui.tsx";

type Tool = "pen" | "highlighter" | "eraser" | "text" | "pan";
type Pt = { x: number; y: number };
type Item =
  | { kind: "stroke"; tool: "pen" | "highlighter" | "eraser"; color: string; width: number; pts: Pt[] }
  | { kind: "text"; color: string; size: number; x: number; y: number; value: string };

const COLORS = ["#18181B", "#2563EB", "#DC2626", "#16A34A", "#F59E0B", "#9333EA"];
const WIDTH: Record<"pen" | "highlighter" | "eraser", number> = { pen: 3, highlighter: 18, eraser: 26 };

function paint(ctx: CanvasRenderingContext2D, items: Item[], w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  for (const it of items) {
    if (it.kind === "text") {
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
      ctx.font = `${it.size}px Inter, system-ui, sans-serif`; ctx.fillStyle = it.color; ctx.textBaseline = "top";
      ctx.fillText(it.value, it.x, it.y);
      continue;
    }
    ctx.globalCompositeOperation = it.tool === "eraser" ? "destination-out" : "source-over";
    ctx.globalAlpha = it.tool === "highlighter" ? 0.32 : 1;
    ctx.strokeStyle = it.color; ctx.fillStyle = it.color; ctx.lineWidth = it.width; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    if (it.pts.length === 1) { ctx.arc(it.pts[0].x, it.pts[0].y, it.width / 2, 0, Math.PI * 2); ctx.fill(); continue; }
    ctx.moveTo(it.pts[0].x, it.pts[0].y);
    // Midpoint quadratic smoothing — hand-drawn lines read as ink, not as jagged polylines.
    for (let i = 1; i < it.pts.length - 1; i++) {
      const mx = (it.pts[i].x + it.pts[i + 1].x) / 2, my = (it.pts[i].y + it.pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(it.pts[i].x, it.pts[i].y, mx, my);
    }
    const last = it.pts[it.pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
}

/** The Tutor's whiteboard layer — a transparent ink surface laid OVER the lesson board (Gauth-style: one big
 *  canvas where Otto writes and the student writes back), with a floating tool pill. Strokes are kept as
 *  resolution-independent items and re-painted, which is what makes undo/redo, a real eraser and crisp
 *  hi-DPI rendering all fall out of one model. "Show Otto" flattens the ink onto white and sends it to the
 *  vision endpoint (same path as before — nothing is stored server-side). The "hand" tool lets pointer
 *  events fall through so the board underneath can still be scrolled. Stays mounted for the whole session so
 *  the drawing survives toggling Desmos. */
export interface TutorCanvasHandle {
  /** True when there is ink Otto hasn't seen yet. */
  hasUnseenInk: () => boolean;
  /** Reads the unseen ink (vision) and returns Otto's description of it, or null when there's nothing new /
   *  vision isn't available / the read failed. Marks the ink as seen on success so it's never sent twice. */
  readUnseenInk: () => Promise<string | null>;
}

export const TutorCanvas = forwardRef<TutorCanvasHandle, { visionReady: boolean; hidden: boolean; onSend: (description: string) => void; onDesmos: () => void }>(function TutorCanvas({ visionReady, hidden, onSend, onDesmos }, handleRef) {
  const L = useLang();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const items = useRef<Item[]>([]);
  const inkStamp = useRef(0);
  const redo = useRef<Item[]>([]);
  const live = useRef<Extract<Item, { kind: "stroke" }> | null>(null);
  const size = useRef({ w: 0, h: 0 });
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[1]);
  const [version, setVersion] = useState(0); // bumps on every committed change → toolbar enable/disable
  const [typing, setTyping] = useState<{ x: number; y: number; value: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLInputElement>(null);

  const repaint = useCallback(() => {
    const c = canvasRef.current, ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(ctx, live.current ? [...items.current, live.current] : items.current, size.current.w, size.current.h);
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current, c = canvasRef.current;
    if (!wrap || !c) return;
    const fit = () => {
      const r = wrap.getBoundingClientRect();
      if (!r.width || !r.height) return; // hidden (Desmos open) — keep the old size, repaint on return
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height };
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
      repaint();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [repaint]);

  useEffect(() => { if (typing) textRef.current?.focus(); }, [typing]);

  const pos = (e: React.PointerEvent): Pt => { const r = canvasRef.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const commit = (it: Item) => { inkStamp.current++; items.current.push(it); redo.current = []; setVersion((v) => v + 1); setError(null); };
  const commitText = () => {
    const t = typing; setTyping(null);
    if (t && t.value.trim()) { commit({ kind: "text", color, size: 22, x: t.x, y: t.y, value: t.value.trim() }); repaint(); }
  };

  // The ink layer sits over the board, which has real controls (problem answer boxes, buttons, links). A
  // press that lands on one of those is a press on THAT control, not the start of a stroke: find it
  // underneath and forward focus/click so the board stays usable without switching tools first.
  const forwarded = useRef<HTMLElement | null>(null);
  const controlUnder = (e: React.PointerEvent): HTMLElement | null => {
    const c = canvasRef.current!;
    const prev = c.style.pointerEvents;
    c.style.pointerEvents = "none";
    const el = document.elementFromPoint(e.clientX, e.clientY);
    c.style.pointerEvents = prev;
    return (el as HTMLElement | null)?.closest<HTMLElement>("button, a[href], input, textarea, select, summary, [role=button]") ?? null;
  };
  const down = (e: React.PointerEvent) => {
    if (tool === "pan" || e.button > 0) return;
    const ctl = tool === "text" ? null : controlUnder(e);
    if (ctl) { forwarded.current = ctl; if (/^(INPUT|TEXTAREA|SELECT)$/.test(ctl.tagName)) ctl.focus(); return; }
    if (tool === "text") { if (typing) { commitText(); return; } setTyping({ ...pos(e), value: "" }); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    live.current = { kind: "stroke", tool, color, width: WIDTH[tool], pts: [pos(e)] };
    repaint();
  };
  const move = (e: React.PointerEvent) => {
    const s = live.current;
    if (!s) return;
    // Coalesced events give every hardware sample on fast pen/finger strokes (smoother than 60Hz frames).
    const evs = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
    const r = canvasRef.current!.getBoundingClientRect();
    if (evs.length) for (const ev of evs) s.pts.push({ x: ev.clientX - r.left, y: ev.clientY - r.top }); else s.pts.push(pos(e));
    repaint();
  };
  const up = (e: React.PointerEvent) => {
    const f = forwarded.current; forwarded.current = null;
    if (f) { if (!/^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName) && controlUnder(e) === f) f.click(); return; }
    const s = live.current; live.current = null;
    if (s) { commit(s); repaint(); }
  };

  const undo = () => { const it = items.current.pop(); if (it) { inkStamp.current++; redo.current.push(it); setVersion((v) => v + 1); repaint(); } };
  const redoFn = () => { const it = redo.current.pop(); if (it) { inkStamp.current++; items.current.push(it); setVersion((v) => v + 1); repaint(); } };
  const clear = () => { inkStamp.current++; items.current = []; redo.current = []; live.current = null; setTyping(null); setVersion((v) => v + 1); repaint(); };

  const hasInk = items.current.some((i) => i.kind === "text" || i.tool !== "eraser");
  void version;

  // Ink counts as "seen" once Otto has read it. `inkStamp` changes on every committed edit, so an unchanged
  // board is never re-sent with the next message.
  const seenStamp = useRef(0);
  const readInk = async (): Promise<string> => {
    const c = canvasRef.current!;
    // Flatten onto white: the canvas is transparent (it sits over the board), but the vision model
    // needs dark ink on a plain light background to read handwriting reliably.
    const flat = document.createElement("canvas");
    flat.width = c.width; flat.height = c.height;
    const f = flat.getContext("2d")!;
    f.fillStyle = "#FFFFFF"; f.fillRect(0, 0, flat.width, flat.height);
    f.drawImage(c, 0, 0);
    const { description } = await api.readWhiteboard(flat.toDataURL("image/png"));
    seenStamp.current = inkStamp.current;
    return description;
  };
  useImperativeHandle(handleRef, () => ({
    hasUnseenInk: () => visionReady && !!canvasRef.current && items.current.some((i) => i.kind === "text" || i.tool !== "eraser") && inkStamp.current !== seenStamp.current,
    readUnseenInk: async () => {
      if (!visionReady || !canvasRef.current || !items.current.some((i) => i.kind === "text" || i.tool !== "eraser") || inkStamp.current === seenStamp.current) return null;
      try { return await readInk(); } catch { return null; }
    },
  }));

  const show = async () => {
    const c = canvasRef.current;
    if (!c || !hasInk || sending) return;
    setSending(true); setError(null);
    try {
      const description = await readInk();
      onSend(description);
    } catch (e: any) {
      setError(e?.status != null ? e.message : L("Otto n'a pas pu lire ton tableau — réessaie.", "Otto couldn't read your board — try again."));
    } finally { setSending(false); }
  };

  const btn = (t: Tool, icon: React.ReactNode, label: string) => (
    <button type="button" className={`tc-btn${tool === t ? " on" : ""}`} onClick={() => { if (typing) commitText(); setTool(t); }} title={label} aria-label={label} aria-pressed={tool === t}>{icon}</button>
  );
  const drawing = tool !== "pan";
  return (
    <div className="tc-layer" ref={wrapRef} style={{ display: hidden ? "none" : undefined, pointerEvents: "none" }}>
      <canvas
        ref={canvasRef}
        className={`tc-canvas tool-${tool}`}
        style={{ pointerEvents: drawing ? "auto" : "none" }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      />
      {typing && (
        <input
          ref={textRef} className="tc-text" style={{ left: typing.x, top: typing.y, color }} value={typing.value}
          placeholder={L("Écris ici…", "Type here…")}
          onChange={(e) => setTyping({ ...typing, value: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") commitText(); if (e.key === "Escape") setTyping(null); }}
          onBlur={commitText}
        />
      )}
      <div className="tc-toolbar" role="toolbar" aria-label={L("Outils du tableau", "Whiteboard tools")} style={{ pointerEvents: "auto" }}>
        {btn("pen", <Pencil size={18} />, L("Stylo", "Pen"))}
        {btn("highlighter", <Highlighter size={18} />, L("Surligneur", "Highlighter"))}
        {btn("eraser", <Eraser size={18} />, L("Gomme", "Eraser"))}
        {btn("text", <Type size={18} />, L("Texte", "Text"))}
        {btn("pan", <Hand size={18} />, L("Défiler le tableau", "Scroll the board"))}
        <span className="tc-sep" aria-hidden />
        {COLORS.map((c) => (
          <button key={c} type="button" className={`tc-swatch${color === c && tool !== "eraser" ? " on" : ""}`} style={{ background: c }} onClick={() => { setColor(c); if (tool === "eraser" || tool === "pan") setTool("pen"); }} aria-label={c} />
        ))}
        <span className="tc-sep" aria-hidden />
        <button type="button" className="tc-btn" onClick={undo} disabled={!items.current.length} title={L("Annuler", "Undo")} aria-label={L("Annuler", "Undo")}><Undo2 size={18} /></button>
        <button type="button" className="tc-btn" onClick={redoFn} disabled={!redo.current.length} title={L("Rétablir", "Redo")} aria-label={L("Rétablir", "Redo")}><Redo2 size={18} /></button>
        <button type="button" className="tc-btn" onClick={clear} disabled={!items.current.length} title={L("Tout effacer", "Clear all")} aria-label={L("Tout effacer", "Clear all")}><Trash2 size={18} /></button>
        <span className="tc-sep" aria-hidden />
        <button type="button" className="tc-btn tc-fn" onClick={onDesmos} title="Desmos" aria-label="Desmos">ƒ</button>
      </div>
      {visionReady && hasInk && (
        <button type="button" className="tc-show" style={{ pointerEvents: "auto" }} onClick={() => void show()} disabled={sending}>
          <Send size={16} /> {sending ? L("Otto regarde…", "Otto is looking…") : L("Montrer à Otto", "Show Otto")}
        </button>
      )}
      {error && <div className="tc-error" role="alert" style={{ pointerEvents: "auto" }}>{error}</div>}
    </div>
  );
});
