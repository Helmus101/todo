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
        placeholder={L("Espace de travail temporaire — effacé entre les sessions.", "Temporary working space — cleared between sessions.")}
        spellCheck={false}
      />
      {value.trim() && (
        <button
          className="sm-scratch-save"
          onClick={() => { onSaveToNotes(value); onChange(""); }}
        >
          {L("Sauver dans les notes", "Save to notes")}
        </button>
      )}
    </div>
  );
}
