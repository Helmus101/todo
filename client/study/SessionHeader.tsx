import { useEffect, useState } from "react";
import type { WebTask } from "../../shared/types.ts";
import type { SessionStatus } from "./StudyTypes.ts";

// Fullscreen hides the OS clock/menu bar — genuinely full-screen (see StudyMode's requestFullscreen) means
// there's no other way to see the wall-clock time while studying. Self-contained (ticks on its own) so no
// prop plumbing is needed from StudyMode's own per-second timer, which drives the elapsed/pomodoro counters.
function WallClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000); // clock display only needs minute-granularity
    return () => clearInterval(id);
  }, []);
  return <span className="sm-clock">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>;
}

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
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Pomodoro: seconds remaining in the current work interval, and which cycle this is — both omitted
   *  when pomodoro isn't enabled for this session. */
  pomodoroRemaining?: number;
  pomodoroCycle?: number;
}

export function SessionHeader({
  taskTitle, currentStep, stepIndex, totalSteps, progress, elapsed, formatTime, onBack, onSubmitStep, sessionStatus,
  isFullscreen, onToggleFullscreen, pomodoroRemaining, pomodoroCycle,
}: SessionHeaderProps) {
  return (
    <header className="sm-header">
      <div className="sm-header-top">
        <button className="sm-back-btn" onClick={onBack} title="Exit study mode">←</button>
        <span className="sm-task-title">{taskTitle}</span>
        <div className="sm-header-right">
          <WallClock />
          {sessionStatus === "paused" && <span className="sm-paused-badge">PAUSED</span>}
          {pomodoroRemaining !== undefined && (
            <span className="sm-pomodoro-badge" title={`Cycle ${(pomodoroCycle || 0) + 1}`}>
              🍅 {formatTime(pomodoroRemaining)}
            </span>
          )}
          <span className="sm-timer">{formatTime(elapsed)}</span>
          {onToggleFullscreen && (
            <button className="sm-fullscreen-btn" onClick={onToggleFullscreen} title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}>
              {isFullscreen ? "⤡" : "⤢"}
            </button>
          )}
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
