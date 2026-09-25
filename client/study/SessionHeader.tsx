import { useEffect, useState } from "react";
import type { WebTask } from "../../shared/types.ts";
import { useLang } from "../ui.tsx";

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
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Pomodoro: seconds remaining in the current work interval, the interval's total length (for the
   *  progress ring), and which cycle this is — all omitted when pomodoro isn't enabled for this session. */
  pomodoroRemaining?: number;
  pomodoroPhaseTotal?: number;
  pomodoroCycle?: number;
}

// A subtle ring around the pomodoro badge — fills as the work interval elapses. Pure decoration (the
// number is what actually matters) but a glance at the ring answers "how much of this interval is left"
// faster than reading digits, and it's cheap: one SVG circle with a dashoffset.
function ProgressRing({ fraction }: { fraction: number }) {
  const r = 9, c = 2 * Math.PI * r;
  const offset = c * (1 - Math.max(0, Math.min(1, fraction)));
  return (
    <svg className="sm-progress-ring" width="22" height="22" viewBox="0 0 22 22">
      <circle cx="11" cy="11" r={r} className="sm-progress-ring-bg" />
      <circle cx="11" cy="11" r={r} className="sm-progress-ring-fg" strokeDasharray={c} strokeDashoffset={offset} />
    </svg>
  );
}

export function SessionHeader({
  taskTitle, currentStep, stepIndex, totalSteps, progress, elapsed, formatTime, onBack, onSubmitStep,
  isFullscreen, onToggleFullscreen, pomodoroRemaining, pomodoroPhaseTotal, pomodoroCycle,
}: SessionHeaderProps) {
  const L = useLang();
  return (
    <header className="sm-header">
      <div className="sm-header-top">
        <button className="sm-back-btn" onClick={onBack} title={L("Quitter le mode révision", "Exit study mode")}>←</button>
        <span className="sm-task-title">{taskTitle}</span>
        <div className="sm-header-right">
          <WallClock />
          {pomodoroRemaining !== undefined && (
            <span className="sm-pomodoro-badge" title={L(`Cycle ${(pomodoroCycle || 0) + 1}`, `Cycle ${(pomodoroCycle || 0) + 1}`)}>
              {pomodoroPhaseTotal ? <ProgressRing fraction={1 - pomodoroRemaining / pomodoroPhaseTotal} /> : null}
              🍅 {formatTime(pomodoroRemaining)}
            </span>
          )}
          <span className="sm-timer">{formatTime(elapsed)}</span>
          {onToggleFullscreen && (
            <button className="sm-fullscreen-btn" onClick={onToggleFullscreen} title={isFullscreen ? L("Quitter le plein écran", "Exit fullscreen") : L("Passer en plein écran", "Enter fullscreen")}>
              {isFullscreen ? "⤡" : "⤢"}
            </button>
          )}
        </div>
      </div>

      {currentStep && (
        <div className="sm-header-step">
          <div className="sm-step-row">
            <div>
              <span className="sm-step-label">{L("EN COURS", "CURRENTLY")}</span>
              <p className="sm-step-text">{currentStep.text}</p>
              {totalSteps > 0 && (
                <span className="sm-step-meta">{L(`Étape ${stepIndex + 1} sur ${totalSteps}`, `Step ${stepIndex + 1} of ${totalSteps}`)}</span>
              )}
            </div>
            <button className="sm-btn sm-btn-ghost sm-btn-sm" onClick={onSubmitStep}>{L("Terminée", "Mark done")}</button>
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
