import { useLang } from "../../ui.tsx";

interface ScratchpadArtifactProps {
  value: string;
  onChange: (v: string) => void;
  onSaveToNotes: (text: string) => void;
}

export function ScratchpadArtifact({ value, onChange, onSaveToNotes }: ScratchpadArtifactProps) {
  const L = useLang();
  return (
    <div className="sm-scratch-body">
      <textarea
        className="sm-notes-textarea sm-scratch-textarea"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={"Temporary working space — cleared between sessions."} aria-label={"Scratchpad"}
        spellCheck={false}
      />
      {value.trim() && (
        <button
          className="sm-scratch-save"
          onClick={() => { onSaveToNotes(value); onChange(""); }}
        >
          {"Save to notes"}
        </button>
      )}
    </div>
  );
}
