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
      {/* No allow-top-navigation — Desmos (or anything it links out to) must never redirect the outer tab. */}
      <iframe
        src="https://www.desmos.com/calculator"
        title="Desmos Graphing Calculator"
        style={{ width: "100%", height: "100%", border: "none" }}
        allow="fullscreen"
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    </div>
  );
}
