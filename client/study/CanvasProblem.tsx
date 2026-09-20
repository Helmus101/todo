import { useState } from "react";
import type { TaskProblem } from "../../shared/types.ts";
import { stripStrayMarkdown, useLang } from "../ui.tsx";

interface CanvasProblemProps {
  problem: TaskProblem;
}

/** The pinned "canvas" header for AskOttoPanel's canvas mode — the current problem, kept visible above the
 *  conversation instead of scrolling away in it, so the student always has the actual question in view
 *  while working through it turn by turn below. Deliberately does NOT self-check an answer the way
 *  InlineProblem.tsx does (no instant correct/wrong reveal, no "why" shown on pick) — canvas mode's whole
 *  point is that Otto guides the student through the problem via the conversation underneath, one step at
 *  a time, rather than the student getting an immediate right/wrong verdict from the UI itself. Options are
 *  shown lettered for reference (so the student can say "I think it's B") but aren't clickable — picking
 *  one happens by telling Otto in the conversation below, not by tapping a button that judges it. */
export function CanvasProblem({ problem }: CanvasProblemProps) {
  const L = useLang();
  const [showHint, setShowHint] = useState(false);
  const isMCQ = Array.isArray(problem.options) && problem.options.length >= 2;

  return (
    <div className="sm-canvas-problem">
      <div className="sm-canvas-problem-label">{L("Sur le canevas", "On the canvas")}</div>
      <div className="sm-canvas-problem-q">{stripStrayMarkdown(problem.question)}</div>
      {problem.format ? <div className="sm-canvas-problem-format">{problem.format}</div> : null}
      {isMCQ ? (
        <div className="sm-canvas-problem-opts">
          {problem.options!.map((opt, oi) => (
            <div key={oi} className="sm-canvas-problem-opt">
              <span className="sm-canvas-problem-opt-letter">{String.fromCharCode(65 + oi)}</span>
              <span>{stripStrayMarkdown(opt)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {problem.hint ? (
        <div className="sm-canvas-problem-hint-row">
          {showHint ? (
            <div className="sm-canvas-problem-hint">{stripStrayMarkdown(problem.hint)}</div>
          ) : (
            <button type="button" className="sm-btn sm-btn-ghost sm-btn-sm" onClick={() => setShowHint(true)}>
              {L("Indice", "Hint")}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
