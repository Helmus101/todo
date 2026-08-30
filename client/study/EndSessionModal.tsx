import { useState } from "react";

interface EndSessionModalProps {
  completedSteps: number;
  totalSteps: number;
  elapsed: number;
  formatTime: (s: number) => string;
  onContinue: () => void;
  onEnd: (review: { finished?: string; confusing?: string; nextStep?: string }) => void;
}

// A ~60-second close-out, not a form: three short optional prompts ("what did I finish", "what confused
// me", "what's the next smallest step") — the same reflection loop as the per-step SubtaskSubmit, just
// once per session instead of once per step. Ending is still one click away (all fields optional) — this
// is a nudge toward reflection, not exit friction for its own sake.
export function EndSessionModal({ completedSteps, totalSteps, elapsed, formatTime, onContinue, onEnd }: EndSessionModalProps) {
  const [finished, setFinished] = useState("");
  const [confusing, setConfusing] = useState("");
  const [nextStep, setNextStep] = useState("");

  return (
    <div className="sm-modal-backdrop">
      <div className="sm-modal">
        <h2>End study session?</h2>
        <p className="sm-modal-sub">Your environment will be saved exactly as it is.</p>

        <div className="sm-modal-stats">
          <div className="sm-modal-stat">
            <span className="sm-modal-stat-value">{formatTime(elapsed)}</span>
            <span className="sm-modal-stat-label">Time studied</span>
          </div>
          {totalSteps > 0 && (
            <div className="sm-modal-stat">
              <span className="sm-modal-stat-value">{completedSteps} / {totalSteps}</span>
              <span className="sm-modal-stat-label">Steps completed</span>
            </div>
          )}
        </div>

        <div className="sm-modal-review">
          <label>
            What did you finish?
            <input value={finished} onChange={(e) => setFinished(e.target.value)} placeholder="Optional" />
          </label>
          <label>
            What confused you?
            <input value={confusing} onChange={(e) => setConfusing(e.target.value)} placeholder="Optional" />
          </label>
          <label>
            What's the next smallest step?
            <input value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="Optional" />
          </label>
        </div>

        <div className="sm-modal-actions">
          <button className="sm-btn sm-btn-ghost" onClick={onContinue}>Continue studying</button>
          <button
            className="sm-btn sm-btn-danger"
            onClick={() => onEnd({
              finished: finished.trim() || undefined,
              confusing: confusing.trim() || undefined,
              nextStep: nextStep.trim() || undefined,
            })}
          >
            End session
          </button>
        </div>
      </div>
    </div>
  );
}
