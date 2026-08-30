import React from "react";
import type { StudyMaterial } from "../../shared/types.ts";
import { WorkspaceIframe } from "./WorkspaceIframe.tsx";

interface ResearchWorkspaceProps {
  browserUrl: string;
  notes: string;
  onBrowserUrlChange: (url: string) => void;
  onNotesChange: (notes: string) => void;
  panes: Record<string, number>; // { browser: 70, notes: 30 }
  setPanes: (panes: Record<string, number>) => void;
}

export function ResearchWorkspace({ browserUrl, notes, onBrowserUrlChange, onNotesChange, panes, setPanes }: ResearchWorkspaceProps) {
  const browserWidth = panes.browser ?? 70;
  const notesWidth = panes.notes ?? 30;

  return (
    <div className="workspace-research" style={{ display: "flex", width: "100%", height: "100%", overflow: "hidden" }}>
      {/* Browser Pane */}
      <div style={{ width: `${browserWidth}%`, height: "100%", display: "flex", flexDirection: "column", borderRight: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "8px", borderBottom: "1px solid var(--border)", backgroundColor: "var(--bg-card)" }}>
          <button style={{ background: "none", border: "none", cursor: "pointer", fontSize: "16px" }}>←</button>
          <button style={{ background: "none", border: "none", cursor: "pointer", fontSize: "16px", marginLeft: "4px" }}>→</button>
          <input
            type="text"
            value={browserUrl}
            onChange={(e) => onBrowserUrlChange(e.target.value)}
            placeholder="Search or enter URL"
            style={{ flex: 1, margin: "0 12px", padding: "6px 12px", borderRadius: "16px", border: "1px solid var(--border)", outline: "none" }}
          />
        </div>
        <div style={{ flex: 1, backgroundColor: "white" }}>
          {browserUrl ? (
            <WorkspaceIframe url={browserUrl} style={{ width: "100%", height: "100%", border: "none" }} title="Browser" />
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#888" }}>
              Web Browser
            </div>
          )}
        </div>
      </div>

      {/* Notes Pane */}
      <div style={{ width: `${notesWidth}%`, height: "100%", display: "flex", flexDirection: "column", backgroundColor: "var(--bg-secondary)" }}>
        <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", fontWeight: 500, fontSize: "14px", backgroundColor: "var(--bg-card)" }}>
          NOTES
        </div>
        <textarea
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="Take notes here..."
          style={{ flex: 1, padding: "16px", border: "none", outline: "none", resize: "none", backgroundColor: "transparent", fontSize: "14px", lineHeight: "1.5" }}
        />
      </div>
    </div>
  );
}
