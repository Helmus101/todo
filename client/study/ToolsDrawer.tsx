import { useRef, useState } from "react";
import type { ArtifactType, WorkspaceTemplate } from "./StudyTypes.ts";

interface ToolsDrawerProps {
  template: WorkspaceTemplate;
  onClose: () => void;
  onAddTool: (type: ArtifactType) => void;
  onAddLink: (url: string) => void;
  backgroundImageName?: string;
  onSetBackground: (file: File) => void;
  onClearBackground: () => void;
}

const ALL_TOOLS: { type: ArtifactType; label: string; icon: string; templates: WorkspaceTemplate[] }[] = [
  { type: "task", label: "Task info", icon: "☰", templates: ["WRITING", "READING", "PROBLEM_SOLVING", "RESEARCH", "REVISION", "PROJECT", "STANDARD"] },
  { type: "notes", label: "Notes", icon: "▤", templates: ["WRITING", "READING", "RESEARCH", "REVISION", "PROJECT", "STANDARD"] },
  { type: "scratchpad", label: "Scratchpad", icon: "✎", templates: ["PROBLEM_SOLVING", "WRITING", "RESEARCH", "STANDARD", "PROJECT"] },
  { type: "calculator", label: "Calculator", icon: "123", templates: ["PROBLEM_SOLVING", "STANDARD"] },
  { type: "desmos", label: "Desmos Graph", icon: "f(x)", templates: ["PROBLEM_SOLVING", "STANDARD"] },
  { type: "dictionary", label: "Dictionary", icon: "Aa", templates: ["WRITING", "READING", "RESEARCH", "REVISION", "PROJECT", "STANDARD"] },
  { type: "whiteboard", label: "Whiteboard", icon: "◻", templates: ["PROBLEM_SOLVING", "WRITING", "PROJECT", "STANDARD", "RESEARCH"] },
  { type: "sticky", label: "Sticky Note", icon: "❏", templates: ["WRITING", "READING", "RESEARCH", "REVISION", "PROJECT", "STANDARD", "PROBLEM_SOLVING"] },
  { type: "citation", label: "Citation", icon: "❞", templates: ["WRITING", "RESEARCH", "PROJECT"] },
];

// Only real Google Docs/Sheets/Slides documents — not an arbitrary-URL opener. Anything else (a random
// site, someone else's app) stays out of Study Mode's desk entirely; this is the one class of external
// content the app treats as trusted enough to embed on the fly, mid-session, without it being a pre-vetted
// task material.
const GSUITE_DOC_RE = /^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\//i;

export function ToolsDrawer({ template, onClose, onAddTool, onAddLink, backgroundImageName, onSetBackground, onClearBackground }: ToolsDrawerProps) {
  const recommended = ALL_TOOLS.filter(t => t.templates.includes(template));
  const others = ALL_TOOLS.filter(t => !t.templates.includes(template));
  const bgInputRef = useRef<HTMLInputElement>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState("");

  const submitLink = () => {
    const url = linkUrl.trim();
    if (!url) return;
    if (!GSUITE_DOC_RE.test(url)) {
      setLinkError("Only Google Docs, Sheets, or Slides links can be opened here.");
      return;
    }
    setLinkError("");
    onAddLink(url);
    setLinkUrl("");
  };

  return (
    <div className="sm-drawer">
      <div className="sm-drawer-header">
        <span>TOOLS</span>
        <button className="sm-drawer-close" onClick={onClose}>×</button>
      </div>
      <div className="sm-drawer-body">
        <div className="sm-tools-divider">Open a Google Doc, Sheet, or Slides</div>
        <div className="sm-bg-row">
          <input
            type="text"
            className="sm-link-input"
            placeholder="Paste a docs.google.com link…"
            value={linkUrl}
            onChange={(e) => { setLinkUrl(e.target.value); setLinkError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") submitLink(); }}
          />
          <button className="sm-btn sm-btn-ghost sm-btn-sm" onClick={submitLink} disabled={!linkUrl.trim()}>Open</button>
        </div>
        {linkError && <p className="sm-bg-filename" style={{ color: "var(--danger, #c0392b)" }}>{linkError}</p>}

        <div className="sm-tools-divider">Add a tool</div>
        <div className="sm-tools-grid">
          {recommended.map(tool => (
            <button
              key={tool.type}
              className="sm-tool-btn"
              onClick={() => { onAddTool(tool.type); onClose(); }}
            >
              <span className="sm-tool-icon">{tool.icon}</span>
              <span className="sm-tool-label">{tool.label}</span>
            </button>
          ))}
          {others.length > 0 && (
            <>
              <div className="sm-tools-divider">Other tools</div>
              {others.map(tool => (
                <button
                  key={tool.type}
                  className="sm-tool-btn sm-tool-btn-other"
                  onClick={() => { onAddTool(tool.type); onClose(); }}
                >
                  <span className="sm-tool-icon">{tool.icon}</span>
                  <span className="sm-tool-label">{tool.label}</span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="sm-tools-divider">Desk background</div>
        <div className="sm-bg-row">
          <button className="sm-btn sm-btn-ghost sm-btn-sm" onClick={() => bgInputRef.current?.click()}>
            {backgroundImageName ? "Replace image" : "Upload image"}
          </button>
          {backgroundImageName && (
            <button className="sm-btn sm-btn-ghost sm-btn-sm" onClick={onClearBackground}>Reset to default</button>
          )}
        </div>
        {backgroundImageName && <p className="sm-bg-filename">{backgroundImageName}</p>}
        <input
          ref={bgInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onSetBackground(f); e.target.value = ""; }}
        />
      </div>
    </div>
  );
}
