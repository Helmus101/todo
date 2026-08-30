import { useRef, useState, useEffect } from "react";
import type { ArtifactState } from "../StudyTypes.ts";

interface WhiteboardArtifactProps {
  artifact: ArtifactState;
  onChange: (contentState: Record<string, unknown>) => void;
}

type Tool = "pen" | "eraser" | "text";
interface Stroke { points: { x: number; y: number }[]; color: string; width: number; }

export function WhiteboardArtifact({ artifact, onChange }: WhiteboardArtifactProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#1a1a2e");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const isDrawing = useRef(false);
  const currentStroke = useRef<{ x: number; y: number }[]>([]);
  const strokes = useRef<Stroke[]>((artifact.contentState?.strokes as Stroke[]) || []);

  const getPos = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    if ("touches" in e) {
      return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
    }
    return { x: (e as React.MouseEvent).clientX - rect.left, y: (e as React.MouseEvent).clientY - rect.top };
  };

  const redraw = () => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !canvasRef.current) return;
    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    strokes.current.forEach(stroke => {
      if (stroke.points.length < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      stroke.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.stroke();
    });
  };

  useEffect(() => { redraw(); }, []);

  const onPointerDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    isDrawing.current = true;
    currentStroke.current = [getPos(e)];
  };

  const onPointerMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current) return;
    const pos = getPos(e);
    currentStroke.current.push(pos);
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const pts = currentStroke.current;
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.strokeStyle = tool === "eraser" ? "#f5f5f0" : color;
    ctx.lineWidth = tool === "eraser" ? 24 : strokeWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.moveTo(pts[pts.length - 2].x, pts[pts.length - 2].y);
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  };

  const onPointerUp = () => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    strokes.current.push({
      points: currentStroke.current,
      color: tool === "eraser" ? "#f5f5f0" : color,
      width: tool === "eraser" ? 24 : strokeWidth,
    });
    currentStroke.current = [];
    onChange({ strokes: strokes.current });
  };

  const clear = () => {
    strokes.current = [];
    redraw();
    onChange({ strokes: [] });
  };

  return (
    <div className="sm-whiteboard-body">
      <div className="sm-whiteboard-toolbar">
        <button className={`sm-wb-btn ${tool === "pen" ? "active" : ""}`} onClick={() => setTool("pen")}>✏ Pen</button>
        <button className={`sm-wb-btn ${tool === "eraser" ? "active" : ""}`} onClick={() => setTool("eraser")}>◻ Erase</button>
        <input type="color" value={color} onChange={e => setColor(e.target.value)} style={{ width: 28, height: 28, border: "none", borderRadius: 4, cursor: "pointer" }} />
        <select value={strokeWidth} onChange={e => setStrokeWidth(Number(e.target.value))} className="sm-wb-select">
          <option value={2}>Thin</option>
          <option value={4}>Normal</option>
          <option value={8}>Thick</option>
        </select>
        <button className="sm-wb-btn" onClick={clear}>Clear</button>
      </div>
      <canvas
        ref={canvasRef}
        className="sm-whiteboard-canvas"
        width={800}
        height={600}
        onMouseDown={onPointerDown}
        onMouseMove={onPointerMove}
        onMouseUp={onPointerUp}
        onMouseLeave={onPointerUp}
        style={{ cursor: tool === "eraser" ? "cell" : "crosshair" }}
      />
    </div>
  );
}
