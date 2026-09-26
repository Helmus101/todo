import { useEffect, useRef, useState } from "react";
import type { WebTask, DiagramOp } from "../../../shared/types.ts";
import { renderChatText, useLang, FirstTimeHint, stripStrayMarkdown } from "../../ui.tsx";

interface BoardArtifactProps {
  task: WebTask;
}

const KIND_LABEL: Record<string, [string, string]> = {
  focus: ["Objectif du jour", "Today's focus"],
  instruction: ["Consigne", "Instruction"],
  formula: ["Formule", "Formula"],
  summary: ["Résumé", "Summary"],
  problem: ["Problème", "Problem"],
  insight: ["Déclic", "Insight"],
  definition: ["Définition", "Definition"],
  diagram: ["Figure", "Figure"],
};

const LABEL_SIZE: Record<string, number> = { sm: 12, md: 14, lg: 18 };

/** Pure mapping from one DiagramOp (shared/types.ts) to its SVG element — DRAW_ON_BOARD's real-figure
 *  rendering (Phase 1: line/rect/circle/polyline/label/axes; equation/KaTeX is Phase 2). Coordinates arrive
 *  already clamped to 0-800x0-600 server-side (makeDiagramEntry) — this component trusts that and just draws. */
function DiagramOpSVG({ op }: { op: DiagramOp }) {
  const stroke = op.op !== "label" && "color" in op && op.color ? op.color : "currentColor";
  switch (op.op) {
    case "line":
      return <line x1={op.x1} y1={op.y1} x2={op.x2} y2={op.y2} stroke={stroke} strokeWidth={2} markerEnd={op.arrow ? "url(#sm-diagram-arrow)" : undefined} />;
    case "rect":
      return <rect x={op.x} y={op.y} width={op.w} height={op.h} stroke={stroke} strokeWidth={2} fill={op.fill ? stroke : "none"} fillOpacity={op.fill ? 0.15 : undefined} />;
    case "circle":
      return <circle cx={op.cx} cy={op.cy} r={op.r} stroke={stroke} strokeWidth={2} fill={op.fill ? stroke : "none"} fillOpacity={op.fill ? 0.15 : undefined} />;
    case "polyline":
      return <polyline points={op.points.map((p) => `${p.x},${p.y}`).join(" ")} stroke={stroke} strokeWidth={2} fill="none" />;
    case "label":
      return <text x={op.x} y={op.y} fontSize={LABEL_SIZE[op.size || "md"]} fill="currentColor">{op.text}</text>;
    case "axes":
      return (
        <g stroke="currentColor" strokeWidth={1.5} fill="currentColor">
          <line x1={op.x} y1={op.y + op.h} x2={op.x + op.w} y2={op.y + op.h} markerEnd="url(#sm-diagram-arrow)" />
          <line x1={op.x} y1={op.y + op.h} x2={op.x} y2={op.y} markerEnd="url(#sm-diagram-arrow)" />
          {op.xLabel ? <text x={op.x + op.w - 4} y={op.y + op.h + 16} fontSize={12} stroke="none" textAnchor="end">{op.xLabel}</text> : null}
          {op.yLabel ? <text x={op.x + 4} y={op.y + 10} fontSize={12} stroke="none">{op.yLabel}</text> : null}
        </g>
      );
    default:
      return null;
  }
}

/** The persistent tutor Board (WRITE_TO_BOARD, server/claude.ts) — a general-purpose surface Otto writes
 *  to at its own discretion, any time: formulas, instructions, running summaries of the student's own reasoning,
 *  and practice problems. Merged canvas functionality - the board now shows both board entries and canvas problems
 *  in one unified surface. */
export function BoardArtifact({ task }: BoardArtifactProps) {
  const L = useLang();
  const endRef = useRef<HTMLDivElement>(null);
  const entries = task.board || [];
  const problems = task.problems || [];
  const [showHint, setShowHint] = useState<{ [key: string]: boolean }>({});

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length, problems.length]);

  const hint = (
    <FirstTimeHint
      id="board"
      title={L("Le tableau d'Otto", "Otto's board")}
      body={L(
        "Otto construit ici un document de séance, entrée par entrée : l'objectif du jour, les définitions et formules clés, tes propres déclics, un résumé de ton raisonnement — et des problèmes à résoudre. Toujours accessible, pas besoin de le rouvrir à chaque fois.",
        "Otto builds a session document here, entry by entry: today's focus, key definitions and formulas, your own insights, a summary of your reasoning — and problems to solve. Always accessible, no need to reopen it each time.",
      )}
    />
  );

  const hasContent = entries.length > 0 || problems.length > 0;

  if (!hasContent) {
    return (
      <div className="sm-board-body">
        {hint}
        <div className="sm-board-empty">
          {L(
            "Le document de séance se construira ici — objectif du jour, définitions, formules, déclics, résumés — dès que ce sera utile.",
            "The session document will build here — today's focus, definitions, formulas, insights, summaries — whenever it's useful.",
          )}
        </div>
      </div>
    );
  }

  const activeProblem = problems.length > 0 ? problems[problems.length - 1] : null;
  const isMCQ = activeProblem && Array.isArray(activeProblem.options) && activeProblem.options.length >= 2;

  return (
    <div className="sm-board-body">
      {hint}
      
      {/* Show active problem if exists */}
      {activeProblem && (
        <div className="sm-board-problem">
          <div className="sm-board-problem-label">{L("Problème actuel", "Current problem")}</div>
          <div className="sm-board-problem-q">{stripStrayMarkdown(activeProblem.question)}</div>
          {activeProblem.format ? <div className="sm-board-problem-format">{activeProblem.format}</div> : null}
          {isMCQ ? (
            <div className="sm-board-problem-opts">
              {activeProblem.options!.map((opt, oi) => (
                <div key={oi} className="sm-board-problem-opt">
                  <span className="sm-board-problem-opt-letter">{String.fromCharCode(65 + oi)}</span>
                  <span>{stripStrayMarkdown(opt)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {activeProblem.hint ? (
            <div className="sm-board-problem-hint-row">
              {showHint[activeProblem.id] ? (
                <div className="sm-board-problem-hint">{stripStrayMarkdown(activeProblem.hint)}</div>
              ) : (
                <button 
                  type="button" 
                  className="sm-btn sm-btn-ghost sm-btn-sm" 
                  onClick={() => setShowHint(prev => ({ ...prev, [activeProblem.id]: true }))}
                >
                  {L("Indice", "Hint")}
                </button>
              )}
            </div>
          ) : null}
        </div>
      )}

      {/* Show board entries */}
      {entries.map((e) => (
        <div key={e.id} className={`sm-board-entry sm-board-entry-${e.kind || "note"}`}>
          {e.kind && KIND_LABEL[e.kind] ? (
            <span className="sm-board-entry-kind">{L(...KIND_LABEL[e.kind])}</span>
          ) : null}
          {e.kind === "diagram" && e.diagram?.length ? (
            <>
              <div className="sm-board-entry-text sm-board-diagram-caption">{stripStrayMarkdown(e.text)}</div>
              <svg viewBox="0 0 800 600" className="sm-board-diagram" preserveAspectRatio="xMidYMid meet">
                <defs>
                  <marker id="sm-diagram-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                    <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
                  </marker>
                </defs>
                {e.diagram.map((op, i) => <DiagramOpSVG key={i} op={op} />)}
              </svg>
            </>
          ) : (
            <div className="sm-board-entry-text">{renderChatText(e.text)}</div>
          )}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
