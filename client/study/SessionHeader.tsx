import type { WebTask } from "../../shared/types.ts";
import type { SessionStatus } from "./StudyTypes.ts";

interface SessionHeaderProps {
  taskTitle: string;
  currentStep: { text: string; estimatedMinutes?: number } | undefined;
  stepIndex: number;
  totalSteps: number;
  progress: number;
  elapsed: number;
  formatTime: (s: number) => string;
  onBack: () => void;
  onSubmitStep: () => void;
  sessionStatus: SessionStatus;
}

export function SessionHeader({
  taskTitle, currentStep, stepIndex, totalSteps, progress, elapsed, formatTime, onBack, onSubmitStep, sessionStatus,
}: SessionHeaderProps) {
  return (
    <header className="sm-header">
      <div className="sm-header-top">
        <button className="sm-back-btn" onClick={onBack} title="Exit study mode">←</button>
        <span className="sm-task-title">{taskTitle}</span>
        <div className="sm-header-right">
          {sessionStatus === "paused" && <span className="sm-paused-badge">PAUSED</span>}
          <span className="sm-timer">{formatTime(elapsed)}</span>
        </div>
      </div>

      {currentStep && (
        <div className="sm-header-step">
          <div className="sm-step-row">
            <div>
              <span className="sm-step-label">CURRENTLY</span>
              <p className="sm-step-text">{currentStep.text}</p>
              {totalSteps > 0 && (
                <span className="sm-step-meta">Step {stepIndex + 1} of {totalSteps}</span>
              )}
            </div>
            <button className="sm-btn sm-btn-ghost sm-btn-sm" onClick={onSubmitStep}>Mark done</button>
          </div>

          {totalSteps > 0 && (
            <div className="sm-progress-row">
              <div className="sm-progress-bar">
                <div className="sm-progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="sm-progress-label">{progress}%</span>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
