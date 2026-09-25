import { useLang } from "../ui.tsx";

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
}

export function BottomBar({ openPanel, onPanelToggle, onAskOtto, chatOpen, onBreak, onEnd, audioPlaying }: BottomBarProps) {
  const L = useLang();
  return (
    <nav className="sm-bottombar">
      <div className="sm-bottombar-left">
        <button
          className={`sm-bar-btn ${openPanel === "task" ? "active" : ""}`}
          onClick={() => onPanelToggle("task")}
        >
          {L("Tâche", "Task")}
        </button>
        <button
          className={`sm-bar-btn ${openPanel === "materials" ? "active" : ""}`}
          onClick={() => onPanelToggle("materials")}
        >
          {L("Matériel", "Materials")}
        </button>
        <button
          className={`sm-bar-btn ${openPanel === "tools" ? "active" : ""}`}
          onClick={() => onPanelToggle("tools")}
        >
          {L("Outils", "Tools")}
        </button>
        <button
          className={`sm-bar-btn ${openPanel === "audio" ? "active" : ""}`}
          onClick={() => onPanelToggle("audio")}
        >
          {L("Audio", "Audio")}{audioPlaying ? L(" · en lecture", " · playing") : ""}
        </button>
        <button
          className={`sm-bar-btn ${chatOpen ? "active" : ""}`}
          onClick={onAskOtto}
        >
          Ask Otto
        </button>
      </div>
      <div className="sm-bottombar-right">
        <button className="sm-bar-btn" onClick={onBreak}>
          {L("Pause", "Break")}
        </button>
        <button className="sm-bar-btn sm-bar-btn-end" onClick={onEnd}>
          {L("Fin", "End")}
        </button>
      </div>
    </nav>
  );
}
