import { useState } from "react";

interface SubtaskSubmitProps {
  stepText: string;
  stepIndex: number;
  totalSteps: number;
  onSubmit: (status: "completed" | "partial" | "stuck", note: string) => void;
  onCancel: () => void;
}

export function SubtaskSubmit({ stepText, stepIndex, totalSteps, onSubmit, onCancel }: SubtaskSubmitProps) {
  const [status, setStatus] = useState<"completed" | "partial" | "stuck" | null>(null);
  const [note, setNote] = useState("");

  return (
    <div className="sm-modal-backdrop">
      <div className="sm-modal">
        <p className="sm-modal-step-label">Step {stepIndex + 1} of {totalSteps}</p>
        <h2>{stepText}</h2>
        <p className="sm-modal-sub">How did it go?</p>

        <div className="sm-submit-options">
          <button
            className={`sm-submit-opt ${status === "completed" ? "selected" : ""}`}
            onClick={() => setStatus("completed")}
          >
            <span>✓</span> Completed
          </button>
          <button
            className={`sm-submit-opt ${status === "partial" ? "selected" : ""}`}
            onClick={() => setStatus("partial")}
          >
            <span>◑</span> Partially completed
          </button>
          <button
            className={`sm-submit-opt ${status === "stuck" ? "selected" : ""}`}
            onClick={() => setStatus("stuck")}
          >
            <span>?</span> I'm stuck
          </button>
        </div>

        {status && (
          <textarea
            className="sm-submit-note"
            placeholder={status === "stuck" ? "What are you stuck on?" : "Optional: what did you complete?"}
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={3}
          />
        )}

        <div className="sm-modal-actions">
          <button className="sm-btn sm-btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            className="sm-btn sm-btn-primary"
            disabled={!status}
            onClick={() => status && onSubmit(status, note)}
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
