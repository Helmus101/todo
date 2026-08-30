import { AUDIO_OPTIONS } from "./StudyMode.tsx";

interface AudioPanelProps {
  audioType: string;
  volume: number;
  playing: boolean;
  onClose: () => void;
  onChange: (type: string, volume: number, playing: boolean) => void;
}

export function AudioPanel({ audioType, volume, playing, onClose, onChange }: AudioPanelProps) {
  return (
    <div className="sm-drawer sm-drawer-audio">
      <div className="sm-drawer-header">
        <span>AUDIO</span>
        <button className="sm-drawer-close" onClick={onClose}>×</button>
      </div>
      <div className="sm-drawer-body">
        <div className="sm-audio-tracks">
          <button
            className={`sm-audio-track ${audioType === "silence" ? "active" : ""}`}
            onClick={() => onChange("silence", volume, false)}
          >
            Silence
          </button>
          {AUDIO_OPTIONS.map(opt => (
            <button
              key={opt.id}
              className={`sm-audio-track ${audioType === opt.id ? "active" : ""}`}
              onClick={() => onChange(opt.id, volume, true)}
            >
              {playing && audioType === opt.id ? "▶ " : ""}{opt.label}
            </button>
          ))}
        </div>

        {audioType !== "silence" && (
          <div className="sm-audio-volume">
            <label>Volume</label>
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={e => onChange(audioType, Number(e.target.value), playing)}
            />
          </div>
        )}

        {audioType !== "silence" && (
          <button
            className="sm-btn sm-btn-ghost"
            onClick={() => onChange(audioType, volume, !playing)}
            style={{ marginTop: "8px" }}
          >
            {playing ? "Pause" : "Play"}
          </button>
        )}
      </div>
    </div>
  );
}
