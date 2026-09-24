import { useEffect, useRef, useState } from "react";
import type { WebTask } from "../../../shared/types.ts";
import { renderChatText, useLang, FirstTimeHint, stripStrayMarkdown } from "../../ui.tsx";

interface BoardArtifactProps {
  task: WebTask;
}

const KIND_LABEL: Record<string, [string, string]> = {
  instruction: ["Consigne", "Instruction"],
  formula: ["Formule", "Formula"],
  summary: ["Résumé", "Summary"],
  problem: ["Problème", "Problem"],
};

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
        "Otto écrit ici de sa propre initiative — une formule à garder sous les yeux, une consigne pour démarrer, un résumé de ton raisonnement une fois un exercice fait, et des problèmes à résoudre. Toujours accessible, pas besoin de le rouvrir à chaque fois.",
        "Otto writes here on its own — a formula worth keeping visible, an instruction to get started, a summary of your own reasoning once you've worked through something, and problems to solve. Always accessible, no need to reopen it each time.",
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
            "Otto écrira ici — formules, consignes, résumés, problèmes — dès que ce sera utile.",
            "Otto will write here — formulas, instructions, summaries, problems — whenever it's useful.",
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
          <div className="sm-board-entry-text">{renderChatText(e.text)}</div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
