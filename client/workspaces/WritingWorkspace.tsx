import React from "react";
import type { StudyMaterial } from "../../shared/types.ts";
import { WorkspaceIframe } from "./WorkspaceIframe.tsx";

interface WritingWorkspaceProps {
  activeResource: StudyMaterial | null;
}

export function WritingWorkspace({ activeResource }: WritingWorkspaceProps) {
  return (
    <div className="workspace-writing" style={{ width: "100%", height: "100%", display: "flex", justifyContent: "center", backgroundColor: "var(--bg-secondary)" }}>
      <div style={{ width: "85%", height: "100%", backgroundColor: "white", boxShadow: "0 0 20px rgba(0,0,0,0.1)" }}>
        {activeResource?.url ? (
          <WorkspaceIframe
            url={activeResource.url}
            style={{ width: "100%", height: "100%", border: "none" }}
            title={activeResource.label}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "#666" }}>
            <h2>Document Editor</h2>
            <p>Select a document from Materials to begin writing.</p>
          </div>
        )}
      </div>
    </div>
  );
}
