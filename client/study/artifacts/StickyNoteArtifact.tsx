import { useState } from "react";
import type { ArtifactState } from "../StudyTypes.ts";

interface StickyNoteArtifactProps {
  artifact: ArtifactState;
  onChange: (contentState: Record<string, unknown>) => void;
}

const STICKY_COLORS = ["#fef3c7", "#dbeafe", "#dcfce7", "#fce7f3", "#f3e8ff"];

export function StickyNoteArtifact({ artifact, onChange }: StickyNoteArtifactProps) {
  const text = (artifact.contentState?.text as string) || "";
  const color = (artifact.contentState?.color as string) || STICKY_COLORS[0];

  return (
    <div className="sm-sticky-body" style={{ backgroundColor: color }}>
      <div className="sm-sticky-colors">
        {STICKY_COLORS.map(c => (
          <button
            key={c}
            className={`sm-sticky-color-btn ${c === color ? "active" : ""}`}
            style={{ backgroundColor: c }}
            onClick={() => onChange({ text, color: c })}
          />
        ))}
      </div>
      <textarea
        className="sm-sticky-textarea"
        style={{ backgroundColor: "transparent" }}
        value={text}
        onChange={e => onChange({ text: e.target.value, color })}
        placeholder="Write a note…"
      />
    </div>
  );
}
