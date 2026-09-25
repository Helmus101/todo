import { useEffect, useState } from "react";
import { useLang } from "../ui.tsx";

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
  const L = useLang();
  return (
    <div className="sm-break-screen">
      <div className="sm-break-inner">
        <WallClock />
        <p className="sm-break-label">{L("PAUSE", "BREAK")}</p>
        <div className="sm-break-timer">{formatTime(elapsed)}</div>
        {countdownRemaining !== undefined && (
          <p className="sm-break-countdown">{L(`Retour au travail dans ${formatTime(countdownRemaining)}`, `Back to work in ${formatTime(countdownRemaining)}`)}</p>
        )}
        <p className="sm-break-hint">{L("Éloigne-toi de l'écran.", "Step away from your screen.")}</p>
        <button className="sm-btn sm-btn-primary" onClick={onResume}>{L("Reprendre", "Resume studying")}</button>
        <button className="sm-btn sm-btn-ghost" onClick={onEnd} style={{ marginTop: "8px" }}>{L("Terminer la session", "End session")}</button>
      </div>
    </div>
  );
}
