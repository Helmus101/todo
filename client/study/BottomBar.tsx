import type { SessionStatus } from "./StudyTypes.ts";

interface BottomBarProps {
  openPanel: string | null;
  onPanelToggle: (panel: "materials" | "tools" | "audio" | "task") => void;
  /** Opens (or brings back into view) the "Ask Otto" chat artifact — no longer a panel toggle, since chat
   *  is now a movable/resizable artifact on the desk like everything else, not a fixed drawer. */
  onAskOtto: () => void;
  chatOpen: boolean;
  onBreak: () => void;
  onEnd: () => void;
  audioPlaying: boolean;
  sessionStatus: SessionStatus;
  onPauseResume: () => void;
}

export function BottomBar({ openPanel, onPanelToggle, onAskOtto, chatOpen, onBreak, onEnd, audioPlaying, sessionStatus, onPauseResume }: BottomBarProps) {
  return (
    <nav className="sm-bottombar">
      <div className="sm-bottombar-left">
        <button
          className={`sm-bar-btn ${openPanel === "task" ? "active" : ""}`}
          onClick={() => onPanelToggle("task")}
        >
          Task
        </button>
        <button
          className={`sm-bar-btn ${openPanel === "materials" ? "active" : ""}`}
          onClick={() => onPanelToggle("materials")}
        >
          Materials
        </button>
        <button
          className={`sm-bar-btn ${openPanel === "tools" ? "active" : ""}`}
          onClick={() => onPanelToggle("tools")}
        >
          Tools
        </button>
        <button
          className={`sm-bar-btn ${openPanel === "audio" ? "active" : ""}`}
          onClick={() => onPanelToggle("audio")}
        >
          Audio{audioPlaying ? " · playing" : ""}
        </button>
        <button
          className={`sm-bar-btn ${chatOpen ? "active" : ""}`}
          onClick={onAskOtto}
        >
          Ask Otto
        </button>
      </div>
      <div className="sm-bottombar-right">
        <button className="sm-bar-btn" onClick={onPauseResume}>
          {sessionStatus === "active" ? "Pause" : "Resume"}
        </button>
        <button className="sm-bar-btn" onClick={onBreak}>
          Break
        </button>
        <button className="sm-bar-btn sm-bar-btn-end" onClick={onEnd}>
          End
        </button>
      </div>
    </nav>
  );
}
