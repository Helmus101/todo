import { useEffect, useRef } from "react";
import type { ArtifactState } from "../StudyTypes.ts";

interface DesmosArtifactProps {
  artifact: ArtifactState;
  onChange: (contentState: Record<string, unknown>) => void;
}

export function DesmosArtifact({ artifact }: DesmosArtifactProps) {
  // Embed Desmos via their public embed URL in an iframe
  // The Desmos embed calculator at https://www.desmos.com/calculator is embeddable
  // as a widget. We use the embed URL directly.
  return (
    <div className="sm-desmos-body">
      <iframe
        src="https://www.desmos.com/calculator"
        title="Desmos Graphing Calculator"
        style={{ width: "100%", height: "100%", border: "none" }}
        allow="fullscreen"
      />
    </div>
  );
}
