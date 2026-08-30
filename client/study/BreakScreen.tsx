interface BreakScreenProps {
  elapsed: number;
  formatTime: (s: number) => string;
  onResume: () => void;
  onEnd: () => void;
}

export function BreakScreen({ elapsed, formatTime, onResume, onEnd }: BreakScreenProps) {
  return (
    <div className="sm-break-screen">
      <div className="sm-break-inner">
        <p className="sm-break-label">BREAK</p>
        <div className="sm-break-timer">{formatTime(elapsed)}</div>
        <p className="sm-break-hint">Step away from your screen.</p>
        <button className="sm-btn sm-btn-primary" onClick={onResume}>Resume studying</button>
        <button className="sm-btn sm-btn-ghost" onClick={onEnd} style={{ marginTop: "8px" }}>End session</button>
      </div>
    </div>
  );
}
