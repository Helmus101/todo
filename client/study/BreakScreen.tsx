import { useEffect, useState } from "react";

function WallClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  return <p className="sm-break-clock">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>;
}

interface BreakScreenProps {
  elapsed: number;
  formatTime: (s: number) => string;
  onResume: () => void;
  onEnd: () => void;
  /** Pomodoro: seconds remaining until this break auto-ends — omitted when pomodoro isn't enabled. */
  countdownRemaining?: number;
}

export function BreakScreen({ elapsed, formatTime, onResume, onEnd, countdownRemaining }: BreakScreenProps) {
  return (
    <div className="sm-break-screen">
      <div className="sm-break-inner">
        <WallClock />
        <p className="sm-break-label">BREAK</p>
        <div className="sm-break-timer">{formatTime(elapsed)}</div>
        {countdownRemaining !== undefined && (
          <p className="sm-break-countdown">Back to work in {formatTime(countdownRemaining)}</p>
        )}
        <p className="sm-break-hint">Step away from your screen.</p>
        <button className="sm-btn sm-btn-primary" onClick={onResume}>Resume studying</button>
        <button className="sm-btn sm-btn-ghost" onClick={onEnd} style={{ marginTop: "8px" }}>End session</button>
      </div>
    </div>
  );
}
