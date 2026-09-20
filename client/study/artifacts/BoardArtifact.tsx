import { useEffect, useRef } from "react";
import type { WebTask } from "../../../shared/types.ts";
import { renderChatText, useLang } from "../../ui.tsx";

interface BoardArtifactProps {
  task: WebTask;
}

const KIND_LABEL: Record<string, [string, string]> = {
  instruction: ["Consigne", "Instruction"],
  formula: ["Formule", "Formula"],
  summary: ["Résumé", "Summary"],
};

/** The persistent tutor Board (WRITE_TO_BOARD, server/claude.ts) — a general-purpose surface Otto writes
 *  to at its own discretion, any time, in or out of canvas mode: formulas, instructions, running summaries
 *  of the student's own reasoning. NOT limited to practice problems (that's InlineProblem/CanvasProblem's
 *  job) and NOT a per-message chat chip — this renders the task's whole `board` log as one continuous,
 *  always-reachable surface, same tier as the whiteboard/notes/camera artifacts on the desk. */
export function BoardArtifact({ task }: BoardArtifactProps) {
  const L = useLang();
  const endRef = useRef<HTMLDivElement>(null);
  const entries = task.board || [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length]);

  if (!entries.length) {
    return (
      <div className="sm-board-empty">
        {L(
          "Otto écrira ici — formules, consignes, résumés — dès que ce sera utile.",
          "Otto will write here — formulas, instructions, summaries — whenever it's useful.",
        )}
      </div>
    );
  }

  return (
    <div className="sm-board-body">
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
