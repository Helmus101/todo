import { useRef, useState } from "react";
import { api } from "../api.ts";
import { useLang } from "../ui.tsx";

interface TutorWhiteboardProps {
  onClose: () => void;
  /** Called with the Gemini-produced transcription once a snapshot is successfully read — the caller sends
   *  it into the normal text-only tutor chat as an ordinary message (see TutorSession's own wiring). This
   *  component never talks to the tutor itself, only to the vision-reading endpoint. */
  onSend: (description: string) => void;
}

type Tool = "pen" | "eraser";
interface Stroke { points: { x: number; y: number }[]; color: string; width: number; }

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

  const getPos = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const scaleX = canvasRef.current!.width / rect.width;
    const scaleY = canvasRef.current!.height / rect.height;
    const point = "touches" in e ? (e.touches[0] || e.changedTouches[0]) : e;
    return { x: (point.clientX - rect.left) * scaleX, y: (point.clientY - rect.top) * scaleY };
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
        <button type="button" className={`btn xs ghost${tool === "pen" ? " active" : ""}`} onClick={() => setTool("pen")}>✏ {L("Stylo", "Pen")}</button>
        <button type="button" className={`btn xs ghost${tool === "eraser" ? " active" : ""}`} onClick={() => setTool("eraser")}>◻ {L("Gomme", "Erase")}</button>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="tutor-whiteboard-color" aria-label={L("Couleur", "Color")} />
        <button type="button" className="btn xs ghost" onClick={clear} disabled={!hasInk}>{L("Effacer tout", "Clear")}</button>
        <button type="button" className="btn xs ghost" onClick={onClose}>{L("← Retour au chat", "← Back to chat")}</button>
      </div>
      <canvas
        ref={canvasRef}
        className="tutor-whiteboard-canvas"
        width={800}
        height={600}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end} onTouchCancel={end}
      />
      <div className="tutor-whiteboard-footer">
        {error ? <span className="tutor-whiteboard-error">{error}</span> : <span className="tutor-whiteboard-hint">{L("Dessine ton travail, puis envoie-le à Otto.", "Draw your work, then send it to Otto.")}</span>}
        <button type="button" className="btn primary xs" onClick={() => void send()} disabled={!hasInk || sending}>
          {sending ? L("Lecture…", "Reading…") : L("Envoyer à Otto", "Send to Otto")}
        </button>
      </div>
    </div>
  );
}
