import { useT } from "../i18n.ts";

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
  const t = useT();
  return (
    <nav className="sm-bottombar">
      <div className="sm-bottombar-left">
        <button
          className={`sm-bar-btn ${openPanel === "task" ? "active" : ""}`}
          onClick={() => onPanelToggle("task")}
        >
          {t("studymode.bar.task")}
        </button>
        <button
          className={`sm-bar-btn ${openPanel === "materials" ? "active" : ""}`}
          onClick={() => onPanelToggle("materials")}
        >
          {t("studymode.bar.materials")}
        </button>
        <button
          className={`sm-bar-btn ${openPanel === "tools" ? "active" : ""}`}
          onClick={() => onPanelToggle("tools")}
        >
          {t("studymode.bar.tools")}
        </button>
        <button
          className={`sm-bar-btn ${openPanel === "audio" ? "active" : ""}`}
          onClick={() => onPanelToggle("audio")}
        >
          {t("studymode.bar.audio")}{audioPlaying ? t("studymode.bar.audioPlayingSuffix") : ""}
        </button>
        <button
          className={`sm-bar-btn ${chatOpen ? "active" : ""}`}
          onClick={onAskOtto}
        >
          {t("studymode.bar.askOtto")}
        </button>
      </div>
      <div className="sm-bottombar-right">
        <button className="sm-bar-btn" onClick={onBreak}>
          {t("studymode.bar.break")}
        </button>
        <button className="sm-bar-btn sm-bar-btn-end" onClick={onEnd}>
          {t("studymode.bar.end")}
        </button>
      </div>
    </nav>
  );
}
