import React from "react";
import type { StudyMaterial } from "../../shared/types.ts";
import { WorkspaceIframe } from "./WorkspaceIframe.tsx";

interface ProblemSolvingWorkspaceProps {
  activeResource: StudyMaterial | null;
  formulaSheet: StudyMaterial | null;
  panes: Record<string, number>;
}

export function ProblemSolvingWorkspace({ activeResource, formulaSheet, panes }: ProblemSolvingWorkspaceProps) {
  const mainWidth = panes.main ?? 60;
  const secondaryWidth = panes.secondary ?? 40;

  return (
    <div className="workspace-problem-solving" style={{ display: "flex", width: "100%", height: "100%" }}>
      <div style={{ width: `${mainWidth}%`, height: "100%", borderRight: "1px solid var(--border)", backgroundColor: "white" }}>
        {activeResource?.url ? (
          <WorkspaceIframe url={activeResource.url} style={{ width: "100%", height: "100%", border: "none" }} title="Problem Set" />
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#666" }}>
            Problem Set
          </div>
        )}
      </div>
      
      <div style={{ width: `${secondaryWidth}%`, height: "100%", backgroundColor: "var(--bg-secondary)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", fontWeight: 500, fontSize: "14px", backgroundColor: "var(--bg-card)" }}>
          FORMULA SHEET
        </div>
        <div style={{ flex: 1, padding: "16px", overflowY: "auto" }}>
          {formulaSheet ? (
             <WorkspaceIframe url={formulaSheet.url} style={{ width: "100%", height: "100%", border: "none" }} title="Formula Sheet" />
          ) : (
             <div style={{ color: "#888", textAlign: "center", marginTop: "40px" }}>No formula sheet attached.</div>
          )}
        </div>
      </div>
    </div>
  );
}
