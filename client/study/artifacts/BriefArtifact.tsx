import { renderNoteBody } from "../../ui.tsx";

interface BriefArtifactProps {
  value: string;
}

// Read-only rendering of an Otto-authored CREATE_NOTE — same renderer the task-card popup uses (headings,
// **bold**, lists, GFM tables), so a brief with a table or heading shows formatted here too, instead of
// dumping raw "## ..."/"| a | b |" markdown into the sticky note's plain-text textarea (StickyNoteArtifact
// is for the student's OWN quick scrawled note, never meant to render markdown).
export function BriefArtifact({ value }: BriefArtifactProps) {
  return (
    <div className="sm-brief-body">
      {value.trim() ? renderNoteBody(value) : <p className="muted">No content.</p>}
    </div>
  );
}
