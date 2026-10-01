import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useLang } from "../ui.tsx";

interface TutorWhiteboardProps {
  onClose: () => void;
  /** Called with the Gemini-produced transcription once a snapshot is successfully read — the caller sends
   *  it into the normal text-only tutor chat as an ordinary message (see TutorSession's own wiring). This
   *  component never talks to the tutor itself, only to the vision-reading endpoint. */
  onSend: (description: string) => void;
}

type Tool = "pen" | "eraser" | "text";
interface Stroke { points: { x: number; y: number }[]; color: string; width: number; }
/** A click with the text tool opens this at the click point (in DISPLAY/CSS pixels, so it can be positioned
 *  with plain absolute CSS over the canvas) — committed text is then baked straight into the canvas raster
 *  via fillText, same as a pen stroke, so it rides along with everything else into the one PNG snapshot
 *  sent to the vision endpoint. There's no separate text layer to keep in sync; once committed it's just
 *  pixels, same as ink. */
interface PendingText { displayX: number; displayY: number; value: string; }

/** A freehand canvas scoped to the Tutor, separate from Study Mode's WhiteboardArtifact (which is tied to
 *  that feature's own ArtifactState persistence and has no export/send capability at all — see the repo
 *  investigation that found no toDataURL/toBlob anywhere). This one's only job is "draw, then hand a PNG
 *  snapshot to the vision-reading endpoint" — nothing here is saved/persisted; closing it without sending
 *  discards the drawing, same as a real whiteboard. */
export function TutorWhiteboard({ onClose, onSend }: TutorWhiteboardProps) {
  const L = useLang();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#18181B");
  const strokeWidth = tool === "eraser" ? 22 : 3;
  const isDrawing = useRef(false);
  const currentStroke = useRef<{ x: number; y: number }[]>([]);
  const strokes = useRef<Stroke[]>([]);
  const [hasInk, setHasInk] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState<PendingText | null>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  const getPos = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const scaleX = canvasRef.current!.width / rect.width;
    const scaleY = canvasRef.current!.height / rect.height;
    const point = "touches" in e ? (e.touches[0] || e.changedTouches[0]) : e;
    return { x: (point.clientX - rect.left) * scaleX, y: (point.clientY - rect.top) * scaleY };
  };
  const getDisplayPos = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const point = "touches" in e ? (e.touches[0] || e.changedTouches[0]) : e;
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  };

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

  const strokeSegment = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.beginPath();
    ctx.strokeStyle = tool === "eraser" ? "#FFFFFF" : color;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  const start = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (tool === "text") {
      if (pendingText) { commitText(); return; } // a second click elsewhere commits the open one first
      const p = getDisplayPos(e);
      setPendingText({ displayX: p.x, displayY: p.y, value: "" });
      return;
    }
    isDrawing.current = true;
    currentStroke.current = [getPos(e)];
  };
  const move = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current) return;
    e.preventDefault();
    const pos = getPos(e);
    const pts = currentStroke.current;
    const prev = pts[pts.length - 1];
    pts.push(pos);
    if (prev) strokeSegment(prev, pos);
    setHasInk(true);
  };
  const end = () => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    if (currentStroke.current.length > 1) strokes.current.push({ points: currentStroke.current, color: tool === "eraser" ? "#FFFFFF" : color, width: strokeWidth });
    currentStroke.current = [];
  };

  const clear = () => {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    strokes.current = [];
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
        <button type="button" className="btn xs ghost" onClick={clear} disabled={!hasInk}>{L("Effacer tout", "Clear")}</button>
        <div className="tutor-whiteboard-toolbar-divider" aria-hidden />
        <button type="button" className="btn xs ghost" onClick={onClose}>{L("← Retour au tableau", "← Back to board")}</button>
      </div>
      <div className="tutor-whiteboard-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="tutor-whiteboard-canvas"
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
