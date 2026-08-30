import type { StudyMaterial } from "./StudyTypes.ts";

interface MaterialsDrawerProps {
  materials: StudyMaterial[];
  onClose: () => void;
  onOpenArtifact: (material: StudyMaterial) => void;
}

const typeIcon = (type: StudyMaterial["type"]) => {
  if (type === "pdf") return "📄";
  if (type === "video") return "▶";
  if (type === "image") return "🖼";
  if (type === "document") return "📝";
  if (type === "note") return "🗒";
  if (type === "flashcard") return "🗂";
  if (type === "quiz") return "❓";
  return "🔗";
};

export function MaterialsDrawer({ materials, onClose, onOpenArtifact }: MaterialsDrawerProps) {
  return (
    <div className="sm-drawer">
      <div className="sm-drawer-header">
        <span>MATERIALS</span>
        <button className="sm-drawer-close" onClick={onClose}>×</button>
      </div>
      <div className="sm-drawer-body">
        {materials.length === 0 ? (
          <p className="sm-drawer-empty">No materials for this session.</p>
        ) : (
          <ul className="sm-material-list">
            {materials.map(m => (
              <li key={m.id} className="sm-material-row">
                <span className="sm-mat-icon">{typeIcon(m.type)}</span>
                <span className="sm-mat-label">{m.label}</span>
                <button
                  className="sm-mat-open"
                  onClick={() => onOpenArtifact(m)}
                  title="Open on canvas"
                >
                  Open ↗
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
