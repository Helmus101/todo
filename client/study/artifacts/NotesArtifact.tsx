import { useLang } from "../../ui.tsx";

interface NotesArtifactProps {
  value: string;
  onChange: (v: string) => void;
}

export function NotesArtifact({ value, onChange }: NotesArtifactProps) {
  const L = useLang();
  return (
    <div className="sm-notes-body">
      <textarea
        className="sm-notes-textarea"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={L("Pas encore de notes.", "No notes yet.")}
        spellCheck
      />
    </div>
  );
}
