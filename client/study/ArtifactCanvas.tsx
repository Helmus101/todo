import { useRef, useCallback } from "react";
import type { WebTask } from "../../shared/types.ts";
import type { ArtifactState } from "./StudyTypes.ts";
import { FlashcardArtifact } from "./artifacts/FlashcardArtifact.tsx";
import { QuizArtifact } from "./artifacts/QuizArtifact.tsx";
import { NotesArtifact } from "./artifacts/NotesArtifact.tsx";
import { ScratchpadArtifact } from "./artifacts/ScratchpadArtifact.tsx";
import { WhiteboardArtifact } from "./artifacts/WhiteboardArtifact.tsx";
import { CalculatorArtifact } from "./artifacts/CalculatorArtifact.tsx";
import { DesmosArtifact } from "./artifacts/DesmosArtifact.tsx";
import { DictionaryArtifact } from "./artifacts/DictionaryArtifact.tsx";
import { StickyNoteArtifact } from "./artifacts/StickyNoteArtifact.tsx";
import { PDFArtifact } from "./artifacts/PDFArtifact.tsx";
import { VideoArtifact } from "./artifacts/VideoArtifact.tsx";
import { DocumentArtifact } from "./artifacts/DocumentArtifact.tsx";
import { ImageArtifact } from "./artifacts/ImageArtifact.tsx";
import { CitationArtifact } from "./artifacts/CitationArtifact.tsx";

interface ArtifactCanvasProps {
  artifacts: ArtifactState[];
  notes: string;
  scratchpad: string;
  task: WebTask;
  taskId: string;
  environmentId: string;
  onUpdateArtifact: (id: string, patch: Partial<ArtifactState>) => void;
  onAddArtifact: (artifact: ArtifactState) => void;
  onRemoveArtifact: (id: string) => void;
  onNotesChange: (notes: string) => void;
  onScratchpadChange: (s: string) => void;
  language?: "fr" | "en";
  backgroundImageUrl?: string | null;
}

export function ArtifactCanvas({
  artifacts, notes, scratchpad, task, taskId, environmentId,
  onUpdateArtifact, onAddArtifact, onRemoveArtifact,
  onNotesChange, onScratchpadChange, language = "en", backgroundImageUrl,
}: ArtifactCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number; width: number; height: number } | null>(null);
  const resizeRef = useRef<{ id: string; startX: number; startY: number; origW: number; origH: number; origX: number; origY: number } | null>(null);

  // Bring artifact to front
  const bringToFront = useCallback((id: string) => {
    const maxZ = Math.max(0, ...artifacts.map(a => a.zIndex));
    onUpdateArtifact(id, { zIndex: maxZ + 1 });
  }, [artifacts, onUpdateArtifact]);

  // Drag start
  const startDrag = useCallback((e: React.PointerEvent, id: string) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    bringToFront(id);
    const art = artifacts.find(a => a.id === id);
    if (!art) return;
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, origX: art.x, origY: art.y, width: art.width, height: art.height };

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current || !canvasRef.current) return;
      const cw = canvasRef.current.offsetWidth;
      const ch = canvasRef.current.offsetHeight;
      const dx = ((ev.clientX - dragRef.current.startX) / cw) * 100;
      const dy = ((ev.clientY - dragRef.current.startY) / ch) * 100;
      const nx = Math.max(0, Math.min(100 - dragRef.current.width, dragRef.current.origX + dx));
      const ny = Math.max(0, Math.min(100 - dragRef.current.height, dragRef.current.origY + dy));
      onUpdateArtifact(dragRef.current.id, { x: nx, y: ny });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [artifacts, bringToFront, onUpdateArtifact]);

  // Resize start
  const startResize = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const art = artifacts.find(a => a.id === id);
    if (!art) return;
    resizeRef.current = { id, startX: e.clientX, startY: e.clientY, origW: art.width, origH: art.height, origX: art.x, origY: art.y };

    const onMove = (ev: PointerEvent) => {
      if (!resizeRef.current || !canvasRef.current) return;
      const cw = canvasRef.current.offsetWidth;
      const ch = canvasRef.current.offsetHeight;
      const dw = ((ev.clientX - resizeRef.current.startX) / cw) * 100;
      const dh = ((ev.clientY - resizeRef.current.startY) / ch) * 100;
      const maxW = 100 - resizeRef.current.origX;
      const maxH = 100 - resizeRef.current.origY;
      const nw = Math.max(18, Math.min(maxW, resizeRef.current.origW + dw));
      const nh = Math.max(24, Math.min(maxH, resizeRef.current.origH + dh));
      onUpdateArtifact(resizeRef.current.id, { width: nw, height: nh });
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [artifacts, onUpdateArtifact]);

  const sortedArtifacts = [...artifacts].sort((a, b) => a.zIndex - b.zIndex);

  const renderContent = (art: ArtifactState) => {
    const contentProps = {
      artifact: art,
      onChange: (contentState: Record<string, unknown>) => onUpdateArtifact(art.id, { contentState }),
    };
    switch (art.type) {
      case "notes":
        return <NotesArtifact value={notes} onChange={onNotesChange} />;
      case "scratchpad":
        return <ScratchpadArtifact value={scratchpad} onChange={onScratchpadChange} onSaveToNotes={(t) => onNotesChange(notes + "\n\n" + t)} />;
      case "whiteboard":
        return <WhiteboardArtifact {...contentProps} />;
      case "calculator":
        return <CalculatorArtifact />;
      case "desmos":
        return <DesmosArtifact {...contentProps} />;
      case "dictionary":
        return <DictionaryArtifact {...contentProps} language={language} />;
      case "sticky":
        return <StickyNoteArtifact {...contentProps} />;
      case "pdf":
        return <PDFArtifact artifact={art} onChange={(contentState) => onUpdateArtifact(art.id, { contentState })} />;
      case "image":
        return <ImageArtifact url={art.source} title={art.title} />;
      case "video":
        return <VideoArtifact url={art.source} title={art.title} />;
      case "document":
        return <DocumentArtifact url={art.source} title={art.title} />;
      case "flashcard":
        return <FlashcardArtifact task={task} deckId={String(art.contentState?.deckId || "")} />;
      case "quiz":
        return <QuizArtifact task={task} quizId={String(art.contentState?.quizId || "")} />;
      case "citation":
        return <CitationArtifact {...contentProps} />;
      default:
        return null;
    }
  };

  return (
    <div
      ref={canvasRef}
      className={`sm-canvas ${backgroundImageUrl ? "sm-canvas-custom-bg" : ""}`}
      style={backgroundImageUrl ? { backgroundImage: `url(${backgroundImageUrl})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
    >
      {sortedArtifacts.map(art => {
        if (art.minimized) {
          return (
            <div key={art.id} className="sm-artifact-minimized" style={{ left: `${art.x}%`, top: "auto", bottom: "60px", zIndex: art.zIndex }}>
              <button onClick={() => onUpdateArtifact(art.id, { minimized: false })}>{art.title}</button>
            </div>
          );
        }

        const isMaximized = art.maximized || art.dockSide === "fullscreen";
        const isDockLeft = art.dockSide === "left";
        const isDockRight = art.dockSide === "right";

        let style: React.CSSProperties = {
          position: "absolute",
          left: `${art.x}%`,
          top: `${art.y}%`,
          width: `${art.width}%`,
          height: `${art.height}%`,
          zIndex: art.zIndex,
        };

        if (isMaximized) {
          style = { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, width: "100%", height: "100%", zIndex: art.zIndex };
        } else if (isDockLeft) {
          style = { position: "absolute", left: 0, top: 0, bottom: 0, width: `${art.width}%`, height: "100%", zIndex: art.zIndex };
        } else if (isDockRight) {
          style = { position: "absolute", right: 0, top: 0, bottom: 0, width: `${art.width}%`, height: "100%", zIndex: art.zIndex };
        }

        return (
          <div
            key={art.id}
            className="sm-artifact"
            style={style}
            onClick={() => bringToFront(art.id)}
          >
            {/* Title bar */}
            <div className="sm-artifact-titlebar" onPointerDown={e => startDrag(e, art.id)}>
              <span className="sm-artifact-title">{art.title}</span>
              <div className="sm-artifact-controls" onPointerDown={(e) => e.stopPropagation()}>
                <button
                  className="sm-artifact-btn"
                  title={art.dockSide === "left" ? "Undock" : "Dock left"}
                  onClick={e => { e.stopPropagation(); onUpdateArtifact(art.id, { dockSide: art.dockSide === "left" ? "none" : "left" }); }}
                >⊟</button>
                <button
                  className="sm-artifact-btn"
                  title={art.dockSide === "right" ? "Undock" : "Dock right"}
                  onClick={e => { e.stopPropagation(); onUpdateArtifact(art.id, { dockSide: art.dockSide === "right" ? "none" : "right" }); }}
                >⊞</button>
                <button
                  className="sm-artifact-btn"
                  title={art.maximized ? "Restore" : "Maximize"}
                  onClick={e => { e.stopPropagation(); onUpdateArtifact(art.id, { maximized: !art.maximized, dockSide: "none" }); }}
                >{art.maximized ? "⊡" : "□"}</button>
                <button
                  className="sm-artifact-btn"
                  title="Minimize"
                  onClick={e => { e.stopPropagation(); onUpdateArtifact(art.id, { minimized: true }); }}
                >−</button>
                <button
                  className="sm-artifact-btn sm-artifact-close"
                  title="Close"
                  onClick={e => { e.stopPropagation(); onRemoveArtifact(art.id); }}
                >×</button>
              </div>
            </div>

            {/* Content */}
            <div className="sm-artifact-body">
              {renderContent(art)}
            </div>

            {/* Resize handle */}
            {!isMaximized && !isDockLeft && !isDockRight && (
              <div
                className="sm-artifact-resize"
                onPointerDown={e => startResize(e, art.id)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
