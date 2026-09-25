import { useCallback, useRef, useState } from "react";
import { SmSurface, SmBackdrop, useLang } from "../ui.tsx";

interface SubtaskSubmitProps {
  stepText: string;
  stepIndex: number;
  totalSteps: number;
  onSubmit: (status: "completed" | "partial" | "stuck", note: string) => void;
  onCancel: () => void;
}

export function SubtaskSubmit({ stepText, stepIndex, totalSteps, onSubmit, onCancel }: SubtaskSubmitProps) {
  const L = useLang();
  const [status, setStatus] = useState<"completed" | "partial" | "stuck" | null>(null);
  const [note, setNote] = useState("");
  // Both exits (Cancel and a real Submit) dismiss back into the same Study Mode screen — unlike
  // EndSessionModal's "End session" (which navigates away), there's no reason for either of these to skip
  // the exit animation, so both route through the same closing-then-unmount timing.
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const doClose = useCallback((after: () => void) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    setTimeout(after, 200);
  }, []);

  return (
    <SmBackdrop closing={closing} className="sm-modal-backdrop">
      <SmSurface variant="modal" closing={closing} className="sm-modal">
        <p className="sm-modal-step-label">{L(`Étape ${stepIndex + 1} sur ${totalSteps}`, `Step ${stepIndex + 1} of ${totalSteps}`)}</p>
        <h2>{stepText}</h2>
        <p className="sm-modal-sub">{L("Comment ça s'est passé ?", "How did it go?")}</p>

        <div className="sm-submit-options">
          <button
            className={`sm-submit-opt ${status === "completed" ? "selected" : ""}`}
            onClick={() => setStatus("completed")}
          >
            <span>✓</span> {L("Terminée", "Completed")}
          </button>
          <button
            className={`sm-submit-opt ${status === "partial" ? "selected" : ""}`}
            onClick={() => setStatus("partial")}
          >
            <span>◑</span> {L("En partie", "Partially completed")}
          </button>
          <button
            className={`sm-submit-opt ${status === "stuck" ? "selected" : ""}`}
            onClick={() => setStatus("stuck")}
          >
            <span>?</span> {L("Je bloque", "I'm stuck")}
          </button>
        </div>

        {status && (
          <textarea
            className="sm-submit-note"
            placeholder={status === "stuck" ? L("Sur quoi est-ce que tu bloques ?", "What are you stuck on?") : L("Facultatif : qu'as-tu terminé ?", "Optional: what did you complete?")}
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={3}
          />
        )}

        <div className="sm-modal-actions">
          <button className="sm-btn sm-btn-ghost" onClick={() => doClose(onCancel)}>{L("Annuler", "Cancel")}</button>
          <button
            className="sm-btn sm-btn-primary"
            disabled={!status}
            onClick={() => status && doClose(() => onSubmit(status, note))}
          >
            {L("Valider", "Submit")}
          </button>
        </div>
      </SmSurface>
    </SmBackdrop>
  );
}
