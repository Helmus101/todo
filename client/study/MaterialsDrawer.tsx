import { useRef, useState } from "react";
import type { StudyMaterial } from "./StudyTypes.ts";
import { useSmClose, SmSurface, useLang } from "../ui.tsx";

interface MaterialsDrawerProps {
  materials: StudyMaterial[];
  onClose: () => void;
  onOpenArtifact: (material: StudyMaterial) => void;
  /** Add one or more files (PDF/image/document) to the ALREADY-RUNNING session — same upload path
   *  StudySetup.tsx uses before a session starts, just reachable mid-session too now. */
  onAddFiles: (files: FileList) => void;
  /** Add a link (or YouTube video) material to the running session. */
  onAddLink: (url: string, label: string) => void;
}

export function MaterialsDrawer({ materials, onClose, onOpenArtifact, onAddFiles, onAddLink }: MaterialsDrawerProps) {
  const L = useLang();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [linkInput, setLinkInput] = useState("");
  const submitLink = () => {
    if (!linkInput.trim()) return;
    onAddLink(linkInput.trim(), linkInput.trim());
    setLinkInput("");
  };
  const { closing, doClose } = useSmClose(onClose, 240);

  const typeIcon = (type: StudyMaterial["type"]) => {
    if (type === "pdf") return "PDF";
    if (type === "video") return "▶";
    if (type === "image") return "▨";
    if (type === "document") return "▤";
    if (type === "note") return "▤";
    if (type === "flashcard") return "❏";
    if (type === "quiz") return "?";
    return L("Lien", "Link");
  };

  return (
    <SmSurface variant="drawer" closing={closing} className="sm-drawer">
      <div className="sm-drawer-header">
        <span>{L("MATÉRIEL", "MATERIALS")}</span>
        <button className="sm-drawer-close" onClick={doClose}>×</button>
      </div>
      <div className="sm-drawer-body">
        {materials.length === 0 ? (
          <p className="sm-drawer-empty">{L("Aucun matériel pour cette session.", "No materials for this session.")}</p>
        ) : (
          <ul className="sm-material-list">
            {materials.map(m => (
              <li key={m.id} className="sm-material-row">
                <span className="sm-mat-icon">{typeIcon(m.type)}</span>
                <span className="sm-mat-label">{m.label}</span>
                <button
                  className="sm-mat-open"
                  onClick={() => onOpenArtifact(m)}
                  title={L("Ouvrir sur le bureau", "Open on canvas")}
                >
                  {L("Ouvrir ↗", "Open ↗")}
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* Add MORE materials without ending the session — realizing mid-study that you need one more PDF
            used to mean closing out and starting over just to reattach it. */}
        <div className="sm-material-add">
          <button className="sm-btn sm-btn-ghost sm-btn-sm" onClick={() => fileInputRef.current?.click()}>
            {L("+ Ajouter un fichier", "+ Add a file")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="application/pdf,image/*,.doc,.docx,.txt,.heic,.heif"
            style={{ display: "none" }}
            onChange={(e) => { if (e.target.files?.length) onAddFiles(e.target.files); e.target.value = ""; }}
          />
          <div className="sm-material-add-link">
            <input
              value={linkInput}
              onChange={(e) => setLinkInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitLink()}
              placeholder={L("Colle un lien (ou une URL YouTube)…", "Paste a link (or YouTube URL)…")}
            />
            <button className="sm-btn sm-btn-ghost sm-btn-sm" onClick={submitLink} disabled={!linkInput.trim()}>{L("Ajouter", "Add")}</button>
          </div>
        </div>
      </div>
    </SmSurface>
  );
}
