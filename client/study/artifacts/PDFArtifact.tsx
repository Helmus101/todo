import type { ArtifactState } from "../StudyTypes.ts";

interface PDFArtifactProps {
  artifact: ArtifactState;
  onChange: (contentState: Record<string, unknown>) => void;
}

export function PDFArtifact({ artifact, onChange }: PDFArtifactProps) {
  const page = Number(artifact.contentState?.page || 1);
  const zoom = Number(artifact.contentState?.zoom || 100);
  const url = artifact.source;
  const src = url ? `${url}#page=${page}&zoom=${zoom}` : "";

  return (
    <div className="sm-pdf-body">
      <div className="sm-artifact-toolbar">
        <label>
          Page
          <input
            className="sm-toolbar-number"
            type="number"
            min={1}
            value={page}
            onChange={(e) => onChange({ ...artifact.contentState, page: Math.max(1, Number(e.target.value) || 1), zoom })}
          />
        </label>
        <label>
          Zoom
          <input
            className="sm-toolbar-range"
            type="range"
            min={60}
            max={180}
            step={10}
            value={zoom}
            onChange={(e) => onChange({ ...artifact.contentState, page, zoom: Number(e.target.value) })}
          />
        </label>
        <span className="sm-toolbar-value">{zoom}%</span>
      </div>
      {url ? (
        <>
          {/* No allow-top-navigation — an external PDF's own content (or a link inside it) must never be
              able to redirect the outer Otto tab. */}
          <iframe className="sm-embed" src={src} title={artifact.title} sandbox="allow-scripts allow-same-origin" />
          {/* Our own CSP allows this (server/index.ts's frame-src), but a THIRD-PARTY PDF host can still
              refuse to be framed via its own X-Frame-Options/CSP — invisible to JS (no onError fires), so
              the student would otherwise be stuck looking at a blank/blocked pane with no way out. */}
          <a className="sm-pdf-fallback-link" href={url} target="_blank" rel="noopener noreferrer">
            Not loading? Open in a new tab ↗
          </a>
        </>
      ) : (
        <div className="sm-artifact-empty">No PDF attached.</div>
      )}
    </div>
  );
}
