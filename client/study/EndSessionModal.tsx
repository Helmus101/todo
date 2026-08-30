interface EndSessionModalProps {
  completedSteps: number;
  totalSteps: number;
  elapsed: number;
  formatTime: (s: number) => string;
  onContinue: () => void;
  onEnd: () => void;
}

export function EndSessionModal({ completedSteps, totalSteps, elapsed, formatTime, onContinue, onEnd }: EndSessionModalProps) {
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

        <div className="sm-modal-actions">
          <button className="sm-btn sm-btn-ghost" onClick={onContinue}>Continue studying</button>
          <button className="sm-btn sm-btn-danger" onClick={onEnd}>End session</button>
        </div>
      </div>
    </div>
  );
}
