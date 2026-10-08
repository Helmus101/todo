import { useRef, useState, useEffect } from "react";
import { Pencil } from "lucide-react";
import type { ArtifactState } from "../StudyTypes.ts";
import { startStroke, inkExtend, renderAllStrokes, type InkPoint, type InkStroke } from "../../ink.ts";

interface WhiteboardArtifactProps {
  artifact: ArtifactState;
  onChange: (contentState: Record<string, unknown>) => void;
}

type Tool = "pen" | "eraser";

/** Paper color baked into the canvas on init — the eraser draws this color. Warm off-white, like notebook
 *  paper, not the clinical #FFFFFF the old version used. */
const PAPER = "#f7f7f2";

/** A freehand canvas in Study Mode. Smooth Bézier ink rendering with velocity-based variable width
 *  (see ink.ts) makes it feel like writing on paper. Strokes persist to ArtifactState (the study tile's
 *  content state) so they survive the tile being closed and reopened. */
export function WhiteboardArtifact({ artifact, onChange }: WhiteboardArtifactProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#1a1a2e");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const isDrawing = useRef(false);
  const currentStroke = useRef<InkStroke | null>(null);
  const strokes = useRef<InkStroke[]>([]);

  // Restore persisted strokes on mount. Old format had { points: {x,y}[], color, width } — map to InkStroke
  // with t:0 (timestamps aren't used by the renderer, only x/y for the Bézier + velocity-from-distance).
  useEffect(() => {
    const loaded = (artifact.contentState?.strokes as any[]) || [];
    strokes.current = loaded.map((s) => ({
      points: (s.points || []).map((p: any) => ({ x: p.x, y: p.y, t: p.t || 0 })),
      color: s.color || PAPER,
      baseWidth: s.width || s.baseWidth || 3,
    }));
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    renderAllStrokes(ctx, strokes.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const baseWidth = tool === "eraser" ? 22 : strokeWidth;

  const getPos = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>): InkPoint => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const scaleX = canvasRef.current!.width / rect.width;
    const scaleY = canvasRef.current!.height / rect.height;
    const point = "touches" in e ? (e.touches[0] || e.changedTouches[0]) : e;
    return { x: (point.clientX - rect.left) * scaleX, y: (point.clientY - rect.top) * scaleY, t: performance.now() };
  };

  const paintPaper = () => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !canvasRef.current) return;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  };

  const redrawAll = () => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    paintPaper();
    renderAllStrokes(ctx, strokes.current);
  };

  const persist = () => {
    onChange({ strokes: strokes.current.map((s) => ({ points: s.points, color: s.color, width: s.baseWidth })) });
  };

  const start = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    isDrawing.current = true;
    const pt = getPos(e);
    currentStroke.current = startStroke(pt, tool === "eraser" ? PAPER : color, baseWidth);
    strokes.current.push(currentStroke.current);
    inkExtend(ctx, currentStroke.current, pt);
  };

  const move = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current || !currentStroke.current) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    inkExtend(ctx, currentStroke.current, getPos(e));
  };

  const end = () => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    currentStroke.current = null;
    persist();
  };

  const undo = () => {
    if (!strokes.current.length) return;
    strokes.current.pop();
    redrawAll();
    persist();
  };

  const clear = () => {
    strokes.current = [];
    paintPaper();
    persist();
  };

  return (
    <div className="sm-whiteboard-body">
      <div className="sm-whiteboard-toolbar">
        <button className={`sm-wb-btn ${tool === "pen" ? "active" : ""}`} onClick={() => setTool("pen")}><Pencil size={13} aria-hidden="true" /> Pen</button>
        <button className={`sm-wb-btn ${tool === "eraser" ? "active" : ""}`} onClick={() => setTool("eraser")}>◻ Erase</button>
        <input type="color" value={color} onChange={e => setColor(e.target.value)} style={{ width: 28, height: 28, border: "none", borderRadius: 4, cursor: "pointer" }} />
        <select value={strokeWidth} onChange={e => setStrokeWidth(Number(e.target.value))} className="sm-wb-select">
          <option value={2}>Thin</option>
          <option value={4}>Normal</option>
          <option value={8}>Thick</option>
        </select>
        <button className="sm-wb-btn" onClick={undo}>↶ Undo</button>
        <button className="sm-wb-btn" onClick={clear}>Clear</button>
      </div>
      <div className="sm-whiteboard-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="sm-whiteboard-canvas tutor-whiteboard-paper"
          width={800}
          height={600}
          onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
          onTouchStart={start} onTouchMove={move} onTouchEnd={end} onTouchCancel={end}
        />
      </div>
    </div>
  );
}
