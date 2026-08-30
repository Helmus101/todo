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
        <iframe className="sm-embed" src={src} title={artifact.title} />
      ) : (
        <div className="sm-artifact-empty">No PDF attached.</div>
      )}
    </div>
  );
}
