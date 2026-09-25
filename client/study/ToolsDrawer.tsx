import { useRef, useState } from "react";
import type { ArtifactType, WorkspaceTemplate } from "./StudyTypes.ts";
import { useSmClose, SmSurface } from "../ui.tsx";

interface ToolsDrawerProps {
  template: WorkspaceTemplate;
  onClose: () => void;
  onAddTool: (type: ArtifactType) => void;
  onAddLink: (url: string) => void;
  backgroundImageName?: string;
  onSetBackground: (file: File) => void;
  onClearBackground: () => void;
  // Off by default (see Profile.betaFeatures in shared/types.ts) — the camera tool must not even be
  // offered here when off. StudyMode.tsx's focus overlay hides its own entry point the same way; this
  // drawer is the OTHER path to the same getUserMedia call (ArtifactCanvas.tsx's "camera" case), reported
  // live as reachable regardless of the overlay's own gate.
  betaFeatures?: boolean;
}

const ALL_TOOLS: { type: ArtifactType; label: string; icon: string; templates: WorkspaceTemplate[] }[] = [
  { type: "task", label: "Task info", icon: "☰", templates: ["WRITING", "READING", "PROBLEM_SOLVING", "RESEARCH", "REVISION", "PROJECT", "STANDARD"] },
  // Recommended everywhere — unlike the other tools, this one isn't something the student reaches for; it's
  // where Otto writes unprompted (formulas, instructions, summaries), so it should always be one click away
  // regardless of what kind of task this is.
  { type: "board", label: "Board", icon: "▦", templates: ["WRITING", "READING", "PROBLEM_SOLVING", "RESEARCH", "REVISION", "PROJECT", "STANDARD"] },
  { type: "camera", label: "Private camera", icon: "◉", templates: ["WRITING", "READING", "PROBLEM_SOLVING", "RESEARCH", "REVISION", "PROJECT", "STANDARD"] },
  { type: "notes", label: "Notes", icon: "▤", templates: ["WRITING", "READING", "RESEARCH", "REVISION", "PROJECT", "STANDARD"] },
  { type: "scratchpad", label: "Scratchpad", icon: "✎", templates: ["PROBLEM_SOLVING", "WRITING", "RESEARCH", "STANDARD", "PROJECT"] },
  { type: "calculator", label: "Calculator", icon: "123", templates: ["PROBLEM_SOLVING", "STANDARD"] },
  { type: "desmos", label: "Desmos Graph", icon: "f(x)", templates: ["WRITING", "READING", "PROBLEM_SOLVING", "RESEARCH", "REVISION", "PROJECT", "STANDARD"] },
  { type: "dictionary", label: "Dictionary", icon: "Aa", templates: ["WRITING", "READING", "RESEARCH", "REVISION", "PROJECT", "STANDARD"] },
  { type: "sticky", label: "Sticky Note", icon: "❏", templates: ["WRITING", "READING", "RESEARCH", "REVISION", "PROJECT", "STANDARD", "PROBLEM_SOLVING"] },
  { type: "citation", label: "Citation", icon: "❞", templates: ["WRITING", "RESEARCH", "PROJECT"] },
];

// Only real Google Docs/Sheets/Slides documents — not an arbitrary-URL opener. Anything else (a random
// site, someone else's app) stays out of Study Mode's desk entirely; this is the one class of external
// content the app treats as trusted enough to embed on the fly, mid-session, without it being a pre-vetted
// task material.
const GSUITE_DOC_RE = /^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\//i;

export function ToolsDrawer({ template, onClose, onAddTool, onAddLink, backgroundImageName, onSetBackground, onClearBackground, betaFeatures = false }: ToolsDrawerProps) {
  const availableTools = betaFeatures ? ALL_TOOLS : ALL_TOOLS.filter(t => t.type !== "camera");
  const recommended = availableTools.filter(t => t.templates.includes(template));
  const others = availableTools.filter(t => !t.templates.includes(template));
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

  const { closing, doClose } = useSmClose(onClose, 240);
  return (
    <SmSurface variant="drawer" closing={closing} className="sm-drawer">
      <div className="sm-drawer-header">
        <span>TOOLS</span>
        <button className="sm-drawer-close" onClick={doClose}>×</button>
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
              onClick={() => { onAddTool(tool.type); doClose(); }}
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
                  onClick={() => { onAddTool(tool.type); doClose(); }}
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
    </SmSurface>
  );
}
