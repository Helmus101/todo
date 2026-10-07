import { createPortal } from "react-dom";
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

export const TutorCanvas = forwardRef<TutorCanvasHandle, { visionReady: boolean; hidden: boolean; surface: HTMLElement | null; onSend: (description: string, note?: string) => void; onDesmos: () => void }>(function TutorCanvas({ visionReady, hidden, surface, onSend, onDesmos }, handleRef) {
  const L = useLang();
  const [askOpen, setAskOpen] = useState(false);
  const [askText, setAskText] = useState("");
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

  // The ink lives ON the board surface: the canvas is portalled INTO the board's scroll container and sized to
  // its full content height, so what the student writes scrolls with Otto's writing — one shared page, like
  // pen on paper — instead of floating over the viewport. (Ink coordinates are page coordinates.)
  useEffect(() => {
    const c = canvasRef.current;
    if (!surface || !c) return;
    const fit = () => {
      const w = surface.clientWidth;
      if (!w) return; // hidden (Desmos open) — keep the old size, repaint on return
      const board = surface.firstElementChild as HTMLElement | null;
      const h = Math.max(surface.clientHeight, board ? board.offsetTop + board.offsetHeight + 300 : 0);
      if (Math.abs(size.current.w - w) < 0.5 && Math.abs(size.current.h - h) < 0.5) return;
      const dpr = window.devicePixelRatio || 1;
      size.current = { w, h };
      c.style.height = `${h}px`;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      repaint();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(surface);
    if (surface.firstElementChild) ro.observe(surface.firstElementChild);
    const mo = new MutationObserver(fit);
    mo.observe(surface, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [surface, repaint]);

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
    // Crop to where the ink actually is (+ margin): the canvas is the whole scrollable page, which would
    // otherwise be a huge mostly-empty image for the vision model.
    const dpr = window.devicePixelRatio || 1;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items.current) {
      if (it.kind === "text") { x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); x1 = Math.max(x1, it.x + it.value.length * it.size * 0.6); y1 = Math.max(y1, it.y + it.size * 1.3); }
      else if (it.tool !== "eraser") for (const p of it.pts) { x0 = Math.min(x0, p.x - it.width); y0 = Math.min(y0, p.y - it.width); x1 = Math.max(x1, p.x + it.width); y1 = Math.max(y1, p.y + it.width); }
    }
    const pad = 24;
    const sx = Math.max(0, x0 - pad), sy = Math.max(0, y0 - pad), sw = Math.min(size.current.w, x1 + pad) - sx, sh = Math.min(size.current.h, y1 + pad) - sy;
    // Flatten onto white: the canvas is transparent (it sits over the board), but the vision model needs
    // dark ink on a plain light background to read handwriting reliably.
    const flat = document.createElement("canvas");
    const scale = Math.min(1, 1600 / Math.max(sw, sh));
    flat.width = Math.max(1, Math.round(sw * dpr * scale)); flat.height = Math.max(1, Math.round(sh * dpr * scale));
    const f = flat.getContext("2d")!;
    f.fillStyle = "#FFFFFF"; f.fillRect(0, 0, flat.width, flat.height);
    f.drawImage(c, sx * dpr, sy * dpr, sw * dpr, sh * dpr, 0, 0, flat.width, flat.height);
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
    const note = askText.trim();
    try {
      const description = await readInk();
      setAskOpen(false); setAskText("");
      onSend(description, note || undefined);
    } catch (e: any) {
      setError(e?.status != null ? e.message : L("Otto n'a pas pu lire ton tableau — réessaie.", "Otto couldn't read your board — try again."));
    } finally { setSending(false); }
  };

  const btn = (t: Tool, icon: React.ReactNode, label: string, tourId?: string) => (
    <button type="button" data-tour={tourId} className={`tc-btn${tool === t ? " on" : ""}`} onClick={() => { if (typing) commitText(); setTool(t); }} title={label} aria-label={label} aria-pressed={tool === t}>{icon}</button>
  );
  const drawing = tool !== "pan";
  return (
    <>
      {surface && createPortal(
        <>
          <canvas
            ref={canvasRef}
            className={`tc-canvas tool-${tool}`}
            style={{ pointerEvents: drawing && !hidden ? "auto" : "none", display: hidden ? "none" : undefined }}
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          />
          {typing && !hidden && (
            <input
              ref={textRef} className="tc-text" style={{ left: typing.x, top: typing.y, color }} value={typing.value}
              placeholder={L("Écris ici…", "Type here…")}
              onChange={(e) => setTyping({ ...typing, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") commitText(); if (e.key === "Escape") setTyping(null); }}
              onBlur={commitText}
            />
          )}
        </>, surface)}
      <div className="tc-layer" style={{ pointerEvents: "none" }}>
        {/* The toolbar is part of the screen chrome, not of the page: same place and same tools whether the
            board, a long scrolled lesson or Desmos is showing (drawing tools just dim while Desmos is up). */}
        <div className={`tc-toolbar${hidden ? " dim" : ""}`} role="toolbar" aria-label={L("Outils du tableau", "Whiteboard tools")} style={{ pointerEvents: "auto" }}>
          {btn("pen", <Pencil size={18} />, L("Stylo", "Pen"))}
          {btn("highlighter", <Highlighter size={18} />, L("Surligneur", "Highlighter"), "tc-highlighter")}
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
          <button type="button" className={`tc-btn tc-fn${hidden ? " on" : ""}`} onClick={onDesmos} title={hidden ? L("Retour au tableau", "Back to the board") : "Desmos"} aria-label="Desmos" aria-pressed={hidden}>ƒ</button>
        </div>
        {visionReady && hasInk && !hidden && (
          <div className="tc-show-wrap" style={{ pointerEvents: "auto" }}>
            {askOpen && (
              <div className="tc-ask" role="dialog" aria-label={L("Dire à Otto quoi regarder", "Tell Otto what to look at")}>
                <label htmlFor="tc-ask-input">{L("Qu'est-ce qu'Otto doit regarder ?", "What should Otto look at?")}</label>
                <textarea id="tc-ask-input" rows={2} autoFocus value={askText} maxLength={400}
                  placeholder={L("ex. Vérifie ma 2e ligne · Est-ce que ce schéma est juste ?", "e.g. Check my 2nd line · Is this diagram right?")}
                  onChange={(e) => setAskText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void show(); } if (e.key === "Escape") setAskOpen(false); }} />
                <div className="tc-ask-actions">
                  <button type="button" className="btn ghost" onClick={() => setAskOpen(false)}>{L("Annuler", "Cancel")}</button>
                  <button type="button" className="btn primary" disabled={sending} onClick={() => void show()}>{sending ? L("Otto regarde…", "Otto is looking…") : L("Envoyer", "Send")}</button>
                </div>
              </div>
            )}
            {!askOpen && (
              <button type="button" className="tc-show" onClick={() => setAskOpen(true)}>
                <Send size={16} /> {L("Montrer à Otto", "Show Otto")}
              </button>
            )}
          </div>
        )}
        {error && <div className="tc-error" role="alert" style={{ pointerEvents: "auto" }}>{error}</div>}
      </div>
    </>
  );
});
