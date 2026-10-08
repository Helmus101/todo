import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useLang } from "../ui.tsx";
import { startStroke, inkExtend, renderAllStrokes, type InkPoint, type InkStroke } from "../ink.ts";

interface TutorWhiteboardProps {
  onClose: () => void;
  /** Called with the Gemini-produced transcription once a snapshot is successfully read — the caller sends
   *  it into the normal text-only tutor chat as an ordinary message (see TutorSession's own wiring). This
   *  component never talks to the tutor itself, only to the vision-reading endpoint. */
  onSend: (description: string) => void;
}

type Tool = "pen" | "eraser" | "text";

/** A click with the text tool opens this at the click point (in DISPLAY/CSS pixels, so it can be positioned
 *  with plain absolute CSS over the canvas) — committed text is then baked straight into the canvas raster
 *  via fillText, same as a pen stroke, so it rides along with everything else into the one PNG snapshot
 *  sent to the vision endpoint. There's no separate text layer to keep in sync; once committed it's just
 *  pixels, same as ink. */
interface PendingText { displayX: number; displayY: number; value: string; }

/** Paper color baked into the canvas on init — the eraser draws this color, and toDataURL includes it so
 *  the vision model sees a paper-colored background rather than transparent. A warm off-white, not the
 *  clinical #FFFFFF the old version used: closer to actual notebook paper. */
const PAPER = "#f7f7f2";

/** A freehand canvas scoped to the Tutor. Smooth Bézier ink rendering with velocity-based variable width
 *  (see ink.ts) makes it feel like writing on paper, not dragging pixels. Once opened, this component is
 *  kept mounted (hidden, not unmounted) by its parent (TutorSession) so the canvas's drawn pixels survive
 *  closing and reopening — only a successful send clears it. */
export function TutorWhiteboard({ onClose, onSend }: TutorWhiteboardProps) {
  const L = useLang();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#1a1a2e");
  const [hasInk, setHasInk] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState<PendingText | null>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  const strokes = useRef<InkStroke[]>([]);
  const currentStroke = useRef<InkStroke | null>(null);
  const isDrawing = useRef(false);

  /** Base pen width — the renderer varies it by velocity (slower = thicker, faster = thinner) on top of this. */
  const baseWidth = tool === "eraser" ? 22 : 3;

  const getPos = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>): InkPoint => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const scaleX = canvasRef.current!.width / rect.width;
    const scaleY = canvasRef.current!.height / rect.height;
    const point = "touches" in e ? (e.touches[0] || e.changedTouches[0]) : e;
    return { x: (point.clientX - rect.left) * scaleX, y: (point.clientY - rect.top) * scaleY, t: performance.now() };
  };
  const getDisplayPos = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const point = "touches" in e ? (e.touches[0] || e.changedTouches[0]) : e;
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  };

  /** Paint the paper background onto the canvas pixels — must be done on mount (and after clear) so the
   *  canvas isn't transparent and toDataURL captures the paper color. */
  const paintPaper = () => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !canvasRef.current) return;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  };

  /** Redraw everything — paper background + all stored strokes. */
  const redrawAll = () => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    paintPaper();
    renderAllStrokes(ctx, strokes.current);
  };

  useEffect(() => { paintPaper(); }, []);
  useEffect(() => { if (pendingText) textInputRef.current?.focus(); }, [pendingText]);

  const commitText = () => {
    const t = pendingText;
    setPendingText(null);
    const value = t?.value.trim();
    if (!t || !value || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleY = canvasRef.current.height / rect.height;
    const scaleX = canvasRef.current.width / rect.width;
    ctx.font = `${Math.round(20 * scaleY)}px sans-serif`;
    ctx.fillStyle = color;
    ctx.textBaseline = "top";
    ctx.fillText(value, t.displayX * scaleX, t.displayY * scaleY);
    setHasInk(true);
  };

  const start = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (tool === "text") {
      if (pendingText) { commitText(); return; }
      const p = getDisplayPos(e);
      setPendingText({ displayX: p.x, displayY: p.y, value: "" });
      return;
    }
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    isDrawing.current = true;
    const pt = getPos(e);
    currentStroke.current = startStroke(pt, tool === "eraser" ? PAPER : color, baseWidth);
    strokes.current.push(currentStroke.current);
    // Draw the initial dot so a quick tap leaves a mark
    inkExtend(ctx, currentStroke.current, pt);
    setHasInk(true);
  };

  const move = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current || !currentStroke.current) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    inkExtend(ctx, currentStroke.current, getPos(e));
    setHasInk(true);
  };

  const end = () => {
    isDrawing.current = false;
    currentStroke.current = null;
  };

  const undo = () => {
    if (!strokes.current.length) return;
    strokes.current.pop();
    redrawAll();
    setHasInk(strokes.current.length > 0);
    setPendingText(null);
  };

  const clear = () => {
    strokes.current = [];
    paintPaper();
    setHasInk(false);
    setError(null);
    setPendingText(null);
  };

  const send = async () => {
    if (!canvasRef.current || !hasInk || sending) return;
    setSending(true);
    setError(null);
    try {
      const dataUrl = canvasRef.current.toDataURL("image/png");
      const { description } = await api.readWhiteboard(dataUrl);
      onSend(description);
      clear();
      onClose();
    } catch (e: any) {
      setError(e?.status != null ? e.message : L("La lecture du tableau a échoué — réessaie.", "Couldn't read the whiteboard — try again."));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="tutor-whiteboard">
      <div className="tutor-whiteboard-toolbar">
        <div className="tutor-whiteboard-tool-group">
          <button type="button" className={`btn xs ghost${tool === "pen" ? " active" : ""}`} onClick={() => setTool("pen")}>✏ {L("Stylo", "Pen")}</button>
          <button type="button" className={`btn xs ghost${tool === "eraser" ? " active" : ""}`} onClick={() => setTool("eraser")}>◻ {L("Gomme", "Erase")}</button>
          <button type="button" className={`btn xs ghost${tool === "text" ? " active" : ""}`} onClick={() => setTool("text")}>🔤 {L("Texte", "Text")}</button>
        </div>
        <div className="tutor-whiteboard-toolbar-divider" aria-hidden />
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="tutor-whiteboard-color" aria-label={L("Couleur", "Color")} />
        <button type="button" className="btn xs ghost" onClick={undo} disabled={!hasInk}>↶ {L("Annuler", "Undo")}</button>
        <button type="button" className="btn xs ghost" onClick={clear} disabled={!hasInk}>{L("Effacer tout", "Clear")}</button>
        <div className="tutor-whiteboard-toolbar-divider" aria-hidden />
        <button type="button" className="btn xs ghost" onClick={onClose}>{L("← Retour au tableau", "← Back to board")}</button>
      </div>
      <div className="tutor-whiteboard-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="tutor-whiteboard-canvas tutor-whiteboard-paper"
          width={800}
          height={600}
          onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
          onTouchStart={start} onTouchMove={move} onTouchEnd={end} onTouchCancel={end}
        />
        {pendingText ? (
          <input
            ref={textInputRef}
            className="tutor-whiteboard-text-input"
            style={{ left: pendingText.displayX, top: pendingText.displayY, color }}
            value={pendingText.value}
            onChange={(e) => setPendingText({ ...pendingText, value: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") commitText(); if (e.key === "Escape") setPendingText(null); }}
            onBlur={commitText}
            placeholder={L("Écris ici…", "Type here…")}
          />
        ) : null}
      </div>
      <div className="tutor-whiteboard-footer">
        {error ? <span className="tutor-whiteboard-error">{error}</span> : <span className="tutor-whiteboard-hint">{tool === "text" ? L("Clique sur le tableau pour écrire, Entrée pour valider.", "Click the board to type, Enter to place it.") : L("Dessine ton travail, puis envoie-le à Otto.", "Draw your work, then send it to Otto.")}</span>}
        <button type="button" className="btn primary xs" onClick={() => void send()} disabled={!hasInk || sending}>
          {sending ? L("Lecture…", "Reading…") : L("Envoyer à Otto", "Send to Otto")}
        </button>
      </div>
    </div>
  );
}
